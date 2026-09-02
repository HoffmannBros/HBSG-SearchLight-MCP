import type { Row } from "./csv.js";
import { SearchLightApiError, type SearchLightClient } from "./client.js";
import { halveWindow, type DateWindow, type Interval } from "./dates.js";

export interface ChunkStats {
  /** Leaf requests that returned data. */
  chunks: number;
  /** Times a request was rejected for size and split. */
  splits: number;
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
): (task: ChunkTask) => Promise<ChunkTask[] | null> {
  return async (task) => {
    let accounts = task.accounts;
    if (accounts === undefined) {
      const all = await client.listAccounts(organization);
      if (all.length > 1) {
        return all.map((a) => ({ accounts: [a], window: task.window }));
      }
      accounts = all.length === 1 ? all : undefined;
    } else if (accounts.length > 1) {
      return accounts.map((a) => ({ accounts: [a], window: task.window }));
    }
    const halves = halveWindow(task.window, interval);
    if (!halves) return null;
    return halves.map((window) => ({ accounts, window }));
  };
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

/** Fetch events rows, splitting on size rejections, streaming rows to `onRows`. */
export async function fetchEventsChunked(
  client: SearchLightClient,
  q: EventsQuery,
  onRows: (rows: Row[], task: ChunkTask) => Promise<void>,
): Promise<ChunkStats> {
  const path = `/api/${encodeURIComponent(q.organization)}/events`;
  return adaptiveFetch<Row[]>(
    { accounts: q.accounts, window: { start: q.start, end: q.end } },
    {
      run: (task) => client.get<Row[]>(path, eventsParams(q, task)),
      emit: onRows,
      split: makeSplitter(client, q.organization, q.interval),
    },
  );
}
