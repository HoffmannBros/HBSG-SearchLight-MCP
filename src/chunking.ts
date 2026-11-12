import type { Row } from "./csv.js";
import { PreflightError, SearchLightApiError, type SearchLightClient } from "./client.js";
import {
  MAX_COMBINATIONS,
  bucketLabel,
  combinationsMessage,
  halveWindow,
  intervalBoundaries,
  type DateWindow,
  type Interval,
} from "./dates.js";

export interface ChunkStats {
  /** Leaf requests that returned data. */
  chunks: number;
  /** Times a request was rejected for size and split. */
  splits: number;
  /** Set when the request was split before sending; says how and why. */
  notes?: string[];
}

export interface ChunkTask {
  /** Account keys for this task; undefined means "as the caller requested" (all, or the given list). */
  accounts: string[] | undefined;
  window: DateWindow;
}

export interface AdaptiveOptions<T> {
  /** Execute one request. Throw SearchLightApiError on failure. */
  run: (task: ChunkTask) => Promise<T>;
  /** Deliver one successful chunk. Called in completion order. */
  emit: (result: T, task: ChunkTask) => Promise<void>;
  /** Called to split a task; return null when it cannot be split further. */
  split: (task: ChunkTask) => Promise<ChunkTask[] | null>;
}

/**
 * Run a request, and whenever the API rejects it as too large, split it and
 * run the pieces concurrently. Children run in parallel (bounded by the
 * client's semaphore); results are emitted as each chunk completes.
 */
export async function adaptiveFetch<T>(task: ChunkTask, opts: AdaptiveOptions<T>): Promise<ChunkStats> {
  const stats: ChunkStats = { chunks: 0, splits: 0 };
  const visit = async (t: ChunkTask): Promise<void> => {
    let result: T;
    try {
      result = await opts.run(t);
    } catch (err) {
      if (!(err instanceof SearchLightApiError) || !err.isSizeLimit()) throw err;
      const children = await opts.split(t);
      if (!children || children.length === 0) throw err;
      stats.splits += 1;
      await Promise.all(children.map(visit));
      return;
    }
    stats.chunks += 1;
    await opts.emit(result, t);
  };
  await visit(task);
  return stats;
}

/**
 * Splitting strategy shared by events and insights: first fan out by
 * account, then halve the date window at an interval boundary.
 */
export function makeSplitter(
  client: SearchLightClient,
  organization: string,
  interval: Interval,
  opts: { allowAccountSplit: boolean },
): (task: ChunkTask) => Promise<ChunkTask[] | null> {
  return async (task) => {
    let accounts = task.accounts;
    if (opts.allowAccountSplit) {
      if (accounts === undefined) {
        const all = await client.listAccounts(organization);
        if (all.length > 1) {
          return all.map((a) => ({ accounts: [a], window: task.window }));
        }
        accounts = all.length === 1 ? all : undefined;
      } else if (accounts.length > 1) {
        return accounts.map((a) => ({ accounts: [a], window: task.window }));
      }
    }
    const halves = halveWindow(task.window, interval);
    if (!halves) return null;
    return halves.map((window) => ({ accounts, window }));
  };
}

/**
 * Fanning out by account only preserves the result's meaning when rows are
 * already broken out by account; otherwise the API's cross-account
 * aggregation would silently become per-account rows.
 */
export function canSplitByAccount(fields: string[]): boolean {
  return fields.includes("account") || fields.includes("accountKey");
}

export interface EventsQuery {
  organization: string;
  fields: string[];
  start: string;
  end: string;
  interval: Interval;
  accounts?: string[] | undefined;
  /** Extra query parameters: filters and the cross-field `filter`. */
  extraParams?: Record<string, string> | undefined;
}

export function eventsParams(q: EventsQuery, task: ChunkTask): Record<string, string | undefined> {
  const accounts = task.accounts ?? q.accounts;
  return {
    ...(q.extraParams ?? {}),
    fields: q.fields.join(","),
    start: task.window.start,
    end: task.window.end,
    interval: q.interval === "total" ? undefined : q.interval,
    account: accounts && accounts.length === 1 ? accounts[0] : undefined,
    accounts: accounts && accounts.length > 1 ? accounts.join(",") : undefined,
  };
}

/** Group consecutive interval buckets into windows of at most `size` buckets, as evenly as possible. */
function groupWindows(buckets: DateWindow[], size: number): DateWindow[] {
  const count = Math.ceil(buckets.length / size);
  const each = Math.ceil(buckets.length / count);
  const out: DateWindow[] = [];
  for (let i = 0; i < buckets.length; i += each) {
    const group = buckets.slice(i, i + each);
    out.push({ start: group[0]!.start, end: group[group.length - 1]!.end });
  }
  return out;
}

export interface EventsPlan {
  tasks: ChunkTask[];
  /** Set when the plan is more than the single request asked for. */
  note?: string;
}

/**
 * Plan the first events requests so none exceeds MAX_COMBINATIONS account x
 * interval combinations, which the API refuses (400 too-many-combinations)
 * at a cost against the hourly limit.
 *
 * `accountList` is the accounts the request covers: the explicit list, or
 * the organization's accounts from the cached `/api`; undefined or empty when
 * unknown, in which case one account is assumed and the adaptive splitter
 * handles any refusal. Splitting by date window never changes the rows,
 * because windows are cut at interval boundaries; splitting by account is
 * only used when rows are broken out by account (`canSplitByAccount`).
 * Throws PreflightError when the request cannot be split without changing
 * its meaning.
 */
export function planEventsTasks(q: EventsQuery, accountList: string[] | undefined): EventsPlan {
  const whole: ChunkTask = { accounts: q.accounts, window: { start: q.start, end: q.end } };
  const accounts = Math.max(1, accountList?.length ?? 0);
  const buckets = intervalBoundaries(q.start, q.end, q.interval);
  const combinations = accounts * buckets.length;
  if (combinations <= MAX_COMBINATIONS) return { tasks: [whole] };

  const what = `${combinations.toLocaleString("en-US")} account x interval combinations (${accounts} account(s) x ${buckets.length} ${bucketLabel(q.interval, buckets.length)}), over SearchLight's limit of ${MAX_COMBINATIONS.toLocaleString("en-US")} per call`;
  const perWindow = Math.floor(MAX_COMBINATIONS / accounts);
  if (perWindow >= 1 && q.interval !== "total") {
    const windows = groupWindows(buckets, perWindow);
    return {
      tasks: windows.map((window) => ({ accounts: q.accounts, window })),
      note: `The request covers ${what}, so it was sent as ${windows.length} requests split by date at ${q.interval} boundaries. The rows are the same as one request would return.`,
    };
  }
  if (canSplitByAccount(q.fields) && accountList && accountList.length > 1) {
    const windows = q.interval === "total" ? [whole.window] : groupWindows(buckets, MAX_COMBINATIONS);
    const tasks = accountList.flatMap((a) => windows.map((window) => ({ accounts: [a], window })));
    return {
      tasks,
      note: `The request covers ${what}, so it was sent as ${tasks.length} requests split by account${windows.length > 1 ? " and date" : ""}. The rows are the same as one request would return.`,
    };
  }
  throw new PreflightError(
    combinationsMessage(
      accounts,
      buckets.length,
      q.interval,
      ", and it cannot be split without changing the rows because they are not broken out by account (add accountKey to fields to allow a per-account split)",
    ),
  );
}

/** The organization's accounts from `/api` (cached), or undefined when it cannot be read. */
async function organizationAccounts(client: SearchLightClient, organization: string): Promise<string[] | undefined> {
  try {
    return await client.listAccounts(organization);
  } catch {
    return undefined;
  }
}

/**
 * Fetch events rows, streaming them to `onRows`. Requests over the
 * account x interval limit are split before sending (see planEventsTasks);
 * any request the API still rejects for size is split and retried.
 */
export async function fetchEventsChunked(
  client: SearchLightClient,
  q: EventsQuery,
  onRows: (rows: Row[], task: ChunkTask) => Promise<void>,
): Promise<ChunkStats> {
  const path = `/api/${encodeURIComponent(q.organization)}/events`;
  // With interval=total there is one bucket per account, so only an explicit
  // list of over 1,000 accounts could trip the limit; skip the lookup.
  const accountList = q.accounts ?? (q.interval === "total" ? undefined : await organizationAccounts(client, q.organization));
  const plan = planEventsTasks(q, accountList);
  const opts: AdaptiveOptions<Row[]> = {
    run: (task) => client.get<Row[]>(path, eventsParams(q, task)),
    emit: onRows,
    split: makeSplitter(client, q.organization, q.interval, { allowAccountSplit: canSplitByAccount(q.fields) }),
  };
  const results = await Promise.all(plan.tasks.map((task) => adaptiveFetch<Row[]>(task, opts)));
  const stats: ChunkStats = {
    chunks: results.reduce((n, r) => n + r.chunks, 0),
    splits: results.reduce((n, r) => n + r.splits, 0),
  };
  if (plan.note) stats.notes = [plan.note];
  return stats;
}

export interface InsightsQuery {
  organization: string;
  accounts?: string[] | undefined;
  start?: string | undefined;
  end?: string | undefined;
  fields?: string[] | undefined;
}

/** Fetch insight documents, splitting by account and then by publication date on the 200-document limit. */
export async function fetchInsightsChunked<T = Row>(
  client: SearchLightClient,
  q: InsightsQuery,
  onDocs: (docs: T[], task: ChunkTask) => Promise<void>,
): Promise<ChunkStats> {
  const path = `/api/${encodeURIComponent(q.organization)}/insights`;
  const dated = q.start !== undefined && q.end !== undefined;
  const splitter = makeSplitter(client, q.organization, dated ? "day" : "total", { allowAccountSplit: true });
  return adaptiveFetch<T[]>(
    { accounts: q.accounts, window: { start: q.start ?? "", end: q.end ?? "" } },
    {
      run: (task) => {
        const accounts = task.accounts ?? q.accounts;
        return client.get<T[]>(path, {
          account: accounts && accounts.length === 1 ? accounts[0] : undefined,
          accounts: accounts && accounts.length > 1 ? accounts.join(",") : undefined,
          start: dated ? task.window.start : undefined,
          end: dated ? task.window.end : undefined,
          fields: q.fields && q.fields.length > 0 ? q.fields.join(",") : undefined,
        });
      },
      emit: onDocs,
      split: splitter,
    },
  );
}
