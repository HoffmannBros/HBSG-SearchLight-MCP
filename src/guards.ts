/**
 * Result guards for events queries: pure functions over the query and its
 * rows that say, in `notes`, when a result is easy to misread, and the one
 * repair made locally (dropping placeholder rows). The tool handlers call
 * these; nothing here sends a request. The claims come from SearchLight's
 * knowledge base (K1, K5 to K8, K12, K14 in the v1.2.0 plan) and were checked
 * live on 2026-11-11 where noted.
 */
import { toNumber } from "./compare.js";
import type { Row } from "./csv.js";
import { MAX_INTERVAL_DAYS, intervalBoundaries, type Interval } from "./dates.js";
import {
  COUNTS_INFLATED_BY_GRADING,
  GRADING_METRICS,
  NOT_MEANINGFUL_AT_RECORD_GRAIN,
  RATE_METRICS,
  RECORD_GRAIN_DIMENSIONS,
  SUMS_ACROSS_INTERVALS,
} from "./fields.js";

/** Dimensions that split rows by time; a split on them keeps every day's spend. */
export const TIME_DIMENSIONS: ReadonlySet<string> = new Set(["date", "dateTime", "createdDateTime", "week", "month"]);
/** The account dimensions, in the order used to key a row by account. */
export const ACCOUNT_DIMENSIONS = ["accountKey", "account"] as const;
/** The value written into dimension columns of an appended unattributed-spend row. */
export const NO_TRACKED_EVENTS = "(no tracked events)";

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const round2 = (n: number) => Math.round(n * 100) / 100;
const list = (names: Iterable<string>) => [...names].join(", ");

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && (value.trim() === "" || value.trim() === "N/A"));
}

function isZeroOrAbsent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return toNumber(value) === 0;
}

function isRecordGrain(dimensions: string[]): boolean {
  return dimensions.some((d) => RECORD_GRAIN_DIMENSIONS.has(d));
}

/* ---------- K1: spend reconciliation ---------- */

/**
 * The fields for the extra unsplit-spend request, or null when no
 * reconciliation applies. It applies to an interval=total query that asks for
 * spend split by at least one dimension other than time and account, and not
 * at record grain (K6: spend is not meaningful on those rows). Live
 * 2026-11-11, one account-week: a channel and campaign split carried 2.78%
 * less spend than the unsplit total; a channel-only split matched exactly.
 */
export function spendReconciliationFields(dimensions: string[], metrics: string[], interval: Interval): string[] | null {
  if (interval !== "total" || !metrics.includes("spend")) return null;
  if (isRecordGrain(dimensions)) return null;
  const splitting = dimensions.filter((d) => !TIME_DIMENSIONS.has(d) && !(ACCOUNT_DIMENSIONS as readonly string[]).includes(d));
  if (splitting.length === 0) return null;
  return [...ACCOUNT_DIMENSIONS.filter((d) => dimensions.includes(d)), "spend"];
}

export interface AccountSpend {
  accountKey?: unknown;
  account?: unknown;
  total: number;
  inRows: number;
  missing: number;
}

export interface SpendReconciliation {
  /** Spend from the unsplit request. */
  total: number;
  /** Sum of spend over the split rows. */
  inRows: number;
  /** total - inRows, rounded to cents; the spend on combinations with no tracked events. */
  missing: number;
  /** Per account, when the rows are broken out by account. */
  byAccount?: AccountSpend[];
}

function accountKeyOf(row: Row, accountFields: string[]): string {
  return JSON.stringify(accountFields.map((f) => row[f] ?? null));
}

/**
 * Compare the split rows' spend with the unsplit request's rows. `accountFields`
 * are the account dimensions both requests carry (empty when the rows are not
 * broken out by account).
 */
export function reconcileSpend(splitRows: Row[], unsplitRows: Row[], accountFields: string[]): SpendReconciliation {
  const spendOf = (r: Row) => toNumber(r.spend) ?? 0;
  const total = round2(unsplitRows.reduce((s, r) => s + spendOf(r), 0));
  const inRows = round2(splitRows.reduce((s, r) => s + spendOf(r), 0));
  const rec: SpendReconciliation = { total, inRows, missing: round2(total - inRows) };
  if (accountFields.length === 0) return rec;

  const inRowsBy = new Map<string, number>();
  for (const r of splitRows) {
    const k = accountKeyOf(r, accountFields);
    inRowsBy.set(k, (inRowsBy.get(k) ?? 0) + spendOf(r));
  }
  const byAccount = new Map<string, AccountSpend>();
  for (const r of unsplitRows) {
    const k = accountKeyOf(r, accountFields);
    const entry = byAccount.get(k) ?? {
      ...Object.fromEntries(accountFields.map((f) => [f, r[f] ?? null])),
      total: 0,
      inRows: round2(inRowsBy.get(k) ?? 0),
      missing: 0,
    };
    entry.total = round2(entry.total + spendOf(r));
    entry.missing = round2(entry.total - entry.inRows);
    byAccount.set(k, entry);
  }
  rec.byAccount = [...byAccount.values()];
  return rec;
}

/** The note for a reconciliation; always says an extra request was sent. */
export function spendReconciliationNote(rec: SpendReconciliation): string {
  if (rec.missing <= 0) {
    return `Spend check: 1 extra request for unsplit spend confirmed the rows carry all ${MONEY.format(rec.total)} of spend (reconcile_spend=false skips it).`;
  }
  const pct = rec.total > 0 ? ` (${((rec.missing / rec.total) * 100).toFixed(1)}%)` : "";
  const short = (rec.byAccount ?? []).filter((a) => a.missing > 0);
  const per =
    short.length > 0
      ? ` By account: ${short.map((a) => `${String(a.accountKey ?? a.account)} ${MONEY.format(a.missing)} of ${MONEY.format(a.total)}`).join("; ")}.`
      : "";
  return `Spend on combinations with no tracked events: ${MONEY.format(rec.missing)} of ${MONEY.format(rec.total)} total spend${pct} is in no row, because SearchLight only returns a dimension combination that has at least one tracked event. Rows carry ${MONEY.format(rec.inRows)}. Take total spend from structuredContent.spendReconciliation, not from the sum of the rows. Found with 1 extra request for unsplit spend (reconcile_spend=false skips it).${per}`;
}

/**
 * Rows carrying the spend the split dropped: one per account (or one in all
 * when rows are not broken out by account), with every other dimension set to
 * "(no tracked events)" and only spend filled.
 */
export function unattributedSpendRows(rec: SpendReconciliation, dimensions: string[]): Row[] {
  const fill = (accountPart: Row, missing: number): Row => {
    const row: Row = {};
    for (const d of dimensions) row[d] = d in accountPart ? accountPart[d] : NO_TRACKED_EVENTS;
    row.spend = missing;
    return row;
  };
  if (rec.byAccount) {
    return rec.byAccount
      .filter((a) => a.missing > 0)
      .map((a) => {
        const part: Row = {};
        for (const f of ACCOUNT_DIMENSIONS) if (f in a) part[f] = a[f];
        return fill(part, a.missing);
      });
  }
  return rec.missing > 0 ? [fill({}, rec.missing)] : [];
}

/* ---------- Notes decided by the query alone ---------- */

/** K5: which requested metrics must not be added up across interval rows. */
export function summingNote(metrics: string[], interval: Interval): string | null {
  if (interval === "total") return null;
  const unsafe = metrics.filter((m) => !SUMS_ACROSS_INTERVALS.has(m));
  if (unsafe.length === 0) return null;
  return `Do not add up ${list(unsafe)} across the ${interval} rows: a customer or job active in two buckets is counted in each (revenue stages too: a job sold in one bucket and closed in the next is in both), so the rows sum to more than the window. Only spend sums exactly. For a window total, request the window as one interval=total row of ${MAX_INTERVAL_DAYS} days or less; over ${MAX_INTERVAL_DAYS} days there is no exact total.`;
}

/** K6: record-grain rows make aggregate metrics meaningless and can repeat an opportunity. */
export function recordGrainNotes(dimensions: string[], metrics: string[]): string[] {
  const grain = dimensions.filter((d) => RECORD_GRAIN_DIMENSIONS.has(d));
  if (grain.length === 0) return [];
  const notes: string[] = [];
  const bad = metrics.filter((m) => NOT_MEANINGFUL_AT_RECORD_GRAIN.has(m));
  if (bad.length > 0) {
    notes.push(
      `${list(grain)} switch${grain.length === 1 ? "es" : ""} the rows to about one per opportunity, where ${list(bad)} ${bad.length === 1 ? "is" : "are"} not meaningful. Fetch ${bad.length === 1 ? "it" : "them"} in a separate call without ${list(grain)}.`,
    );
  }
  if (dimensions.includes("opportunityId")) {
    notes.push("One opportunity can return several rows (one per job). Dedupe on opportunityId before counting opportunities.");
  }
  return notes;
}

/** K5 for compare_periods: revenue stages and paying customers move between periods. */
const CROSS_PERIOD_METRICS = ["soldRevenue", "estimatedRevenue", "revenuePotential", "payingCustomers"];

export function crossPeriodNote(metrics: string[]): string | null {
  const hit = metrics.filter((m) => CROSS_PERIOD_METRICS.includes(m));
  if (hit.length === 0) return null;
  return `${list(hit)}: a job sold in the earlier period and closed in the later one appears in both, so do not add the two periods together, and read a change as movement between stages as well as new work.`;
}

/**
 * K12 for compare_periods: add `m_points` (the change times 100) for each rate
 * metric. Returns the rate metrics that got one.
 */
export function addPercentagePoints(rows: Row[], metrics: string[]): string[] {
  const rates = metrics.filter((m) => RATE_METRICS.has(m));
  for (const row of rows) {
    for (const m of rates) {
      const change = toNumber(row[`${m}_change`]);
      // Rounded to 1e-6 points so 0.05 reads 5, not 5.000000000000001.
      row[`${m}_points`] = change === null ? null : Math.round(change * 100 * 1e6) / 1e6;
    }
  }
  return rates;
}

export function percentagePointsNote(rates: string[]): string | null {
  if (rates.length === 0) return null;
  return `For ${list(rates)}, m_pct is the relative change ((current - previous) / previous) and m_points is the change in percentage points. Say which one you mean.`;
}

/** Insert `m_points` after `m_pct` for each rate metric. */
export function columnsWithPoints(columns: string[], rates: string[]): string[] {
  const out: string[] = [];
  for (const c of columns) {
    out.push(c);
    const m = c.endsWith("_pct") ? c.slice(0, -4) : null;
    if (m && rates.includes(m)) out.push(`${m}_points`);
  }
  return out;
}

export function periodLengthNote(currentDays: number, previousDays: number): string | null {
  if (currentDays === previousDays) return null;
  return `The periods differ in length: the current period is ${currentDays} days and the comparison period is ${previousDays} days. Counts, spend and revenue are not adjusted for it; compare rates, or per-day figures.`;
}

/* ---------- Guards over the rows as they stream ---------- */

export interface RowGuardOptions {
  dimensions: string[];
  metrics: string[];
  interval: Interval;
  start: string;
  end: string;
  /** K7: drop all-blank, all-zero rows. */
  dropPlaceholders: boolean;
  /** Field names the request filters on (filters keys and names in the cross-field filter). */
  filterFields: string[];
}

/**
 * Watches the rows of one events result as they arrive (chunks may arrive in
 * any order) and produces the notes that depend on them.
 */
export class RowGuard {
  private kept = 0;
  private dropped = 0;
  private zeroSpend = 0;
  private readonly buckets = new Set<string>();
  private readonly combos = new Map<string, Set<string>>();
  private readonly comboDimensions: string[];

  constructor(private readonly opts: RowGuardOptions) {
    this.comboDimensions = opts.dimensions.filter((d) => !TIME_DIMENSIONS.has(d));
  }

  /** K7: a row with every requested dimension blank and every metric 0 or absent. */
  isPlaceholder(row: Row): boolean {
    const { dimensions, metrics } = this.opts;
    if (dimensions.length === 0) return false;
    return dimensions.every((d) => isBlank(row[d])) && metrics.every((m) => isZeroOrAbsent(row[m]));
  }

  /** Tally a chunk and return the rows to keep. */
  accept(rows: Row[]): Row[] {
    const out = this.opts.dropPlaceholders ? rows.filter((r) => !this.isPlaceholder(r)) : rows;
    this.dropped += rows.length - out.length;
    this.kept += out.length;
    for (const r of out) {
      if (this.opts.metrics.includes("spend") && isZeroOrAbsent(r.spend)) this.zeroSpend += 1;
      if (this.opts.interval !== "total" && typeof r.start === "string") {
        const b = r.start.slice(0, 10);
        this.buckets.add(b);
        if (this.comboDimensions.length > 0) {
          const k = JSON.stringify(this.comboDimensions.map((d) => r[d] ?? null));
          if (!this.combos.has(k)) this.combos.set(k, new Set());
          this.combos.get(k)!.add(b);
        }
      }
    }
    return out;
  }

  get rowCount(): number {
    return this.kept;
  }

  notes(): string[] {
    const notes: string[] = [];
    const { dimensions, metrics, interval } = this.opts;
    if (this.dropped > 0) {
      notes.push(
        `Dropped ${this.dropped} placeholder row(s) with every dimension blank or N/A and every metric 0; totals are unchanged (drop_placeholder_rows=false keeps them).`,
      );
    }
    if (interval !== "total" && this.kept > 0) {
      const expected = intervalBoundaries(this.opts.start, this.opts.end, interval);
      const seen = [...this.buckets];
      const missing = expected.filter((w) => !seen.some((b) => b >= w.start && b <= w.end)).map((w) => w.start);
      if (missing.length > 0) {
        const shown = missing.slice(0, 24);
        notes.push(
          `No rows for ${missing.length} of ${expected.length} ${interval} bucket(s), starting ${shown.join(", ")}${missing.length > shown.length ? `, and ${missing.length - shown.length} more` : ""}. SearchLight omits a bucket with no activity rather than returning zeros, so these mean zero activity.`,
        );
      }
      if (this.combos.size > 1) {
        const present = this.buckets.size;
        const gaps = [...this.combos.values()].filter((s) => s.size < present).length;
        if (gaps > 0) {
          notes.push(
            `${gaps} of ${this.combos.size} ${list(this.comboDimensions)} value(s) have no row in some ${interval} buckets; a missing row means zero for that bucket, not missing data.`,
          );
        }
      }
    }
    if (this.kept === 0 && this.opts.filterFields.includes("customerPhone")) {
      notes.push(
        "No rows: customerPhone is redacted, so a filter on it never matches. Filter on customerName or customerEmail with a regex instead, for example {\"customerName\": [\"regex\", \"smith\"]}.",
      );
    }
    const roas = metrics.filter((m) => m === "roasClosed" || m === "roasPotential");
    if (roas.length > 0 && dimensions.length > 0 && metrics.includes("spend") && this.zeroSpend > 0) {
      notes.push(
        `${this.zeroSpend} of ${this.kept} row(s) have zero spend; ${list(roas)} ${roas.length === 1 ? "is" : "are"} not meaningful there. Leave those rows out before comparing ROAS.`,
      );
    }
    return notes;
  }
}

/** Field names a request filters on: `filters` keys plus names inside the cross-field `filter`. */
export function filterFieldNames(filters: Record<string, unknown> | undefined, crossFilter: unknown[] | undefined): string[] {
  const names = new Set(Object.keys(filters ?? {}));
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) {
        names.add(k);
        walk(inner);
      }
    }
  };
  walk(crossFilter);
  return [...names];
}

/* ---------- Automatic repairs (W2-B): K4 note, K2 fallback, K9 check ---------- */

/**
 * K4: counts requested beside grading metrics read high. SearchLight measured
 * leads +18.7% and +22.5% (2026-07-27). Not reproducible here (these accounts
 * have no grading data), so the request is sent unchanged with this note.
 */
export function gradingNote(metrics: string[]): string | null {
  const grading = metrics.filter((m) => GRADING_METRICS.has(m));
  const counts = metrics.filter((m) => COUNTS_INFLATED_BY_GRADING.has(m));
  if (grading.length === 0 || counts.length === 0) return null;
  return `${list(counts)} ${counts.length === 1 ? "was" : "were"} requested beside the grading metric${grading.length === 1 ? "" : "s"} ${list(grading)}. SearchLight measured counts like these reading high (leads by about 19 to 23%) when grading metrics are in the same request. Request ${list(counts)} in a separate call without grading metrics and use those figures. This request was sent unchanged.`;
}

/** Most values an `or` filter is expanded into; above it, the fallback does not retry. */
export const MAX_OR_EXPANSION = 12;

export type ScalarFilterValue = string | number | boolean;

export interface OrFilter {
  field: string;
  values: ScalarFilterValue[];
}

/** A filter value as SearchLight reads it: a string holding a JSON list is a list. */
function filterExpression(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (!t.startsWith("[")) return value;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return value;
  }
}

const isScalar = (v: unknown): v is ScalarFilterValue => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * Per-field filters (in the caller's order) that are a top-level
 * `["or", v1, v2, ...]` with every argument a plain string, number or boolean:
 * the form K2 says can answer 200 with an empty body.
 */
export function qualifyingOrFilters(filters: Record<string, unknown> | undefined): OrFilter[] {
  const out: OrFilter[] = [];
  for (const [field, raw] of Object.entries(filters ?? {})) {
    const expr = filterExpression(raw);
    if (!Array.isArray(expr) || expr[0] !== "or" || expr.length < 2) continue;
    const values = expr.slice(1);
    if (values.every(isScalar)) out.push({ field, values: [...new Set(values)] });
  }
  return out;
}

/** Per-field filters using `regex` or `not` anywhere in their expression. */
export function regexOrNotFilterFields(filters: Record<string, unknown> | undefined): string[] {
  const uses = (v: unknown): boolean =>
    Array.isArray(v) && ((v[0] === "regex" || v[0] === "not") || v.slice(1).some(uses));
  return Object.entries(filters ?? {})
    .filter(([, raw]) => uses(filterExpression(raw)))
    .map(([field]) => field);
}

/** The query parameter value for a plain equality filter. */
export function equalityParam(value: ScalarFilterValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export interface OrFallbackResult {
  filter: OrFilter;
  /** True when the field was not in `fields` and was added to each retry. */
  addedField: boolean;
  /** Rows returned for each value, in the order sent. */
  rowsPerValue: number[];
  /** Other qualifying `or` filters that were left as they were. */
  otherFields: string[];
}

export function orFallbackNote(r: OrFallbackResult): string {
  const { field, values } = r.filter;
  const total = r.rowsPerValue.reduce((a, b) => a + b, 0);
  const parts = [
    `The ${field} filter ["or", ...] answered no rows, which is a known SearchLight fault for or filters (it sometimes answers an empty result where single values return rows). Re-sent once per value with a plain equality filter on ${field}: ${values.length} extra request(s), ${values.map((v, i) => `${JSON.stringify(v)} ${r.rowsPerValue[i]} row(s)`).join(", ")}; ${total} row(s) in all.`,
    r.addedField
      ? `${field} was not in fields, so it was added to each retry to keep the values apart; the rows are one per ${field} value (sum them for the combined figure).`
      : `The rows for each ${field} value are concatenated.`,
    `Counts, spend and revenue add up across the values; rates and averages are per value and must not be added.`,
  ];
  if (r.otherFields.length > 0) {
    parts.push(`Only one filter is expanded; the or filter${r.otherFields.length === 1 ? "" : "s"} on ${list(r.otherFields)} ${r.otherFields.length === 1 ? "was" : "were"} sent as given.`);
  }
  parts.push("retry_or_filters=false turns this off.");
  return parts.join(" ");
}

export function orTooManyNote(filter: OrFilter): string {
  return `The ${filter.field} filter ["or", ...] answered no rows, which can be a known SearchLight fault for or filters. It has ${filter.values.length} values, over the ${MAX_OR_EXPANSION} this tool will retry one at a time, so it was not retried. Query fewer values at once, or one value per call with a plain equality filter.`;
}

export function regexOrNotEmptyNote(fields: string[]): string {
  return `No rows, and the filter on ${list(fields)} uses regex or not. SearchLight sometimes answers such filters with an empty result where equality filters return rows, so the empty answer may be the filter rather than the data. Not retried; try plain equality filters, one value per call.`;
}

/** Days over which an interval=total read is cross-checked by month when it reads zero (K9). */
export const ZERO_TOTAL_CHECK_DAYS = 31;

/** Whether every requested metric is 0 or absent in every row (true for no rows). */
export function allMetricsZero(rows: Row[], metrics: string[]): boolean {
  return rows.every((r) => metrics.every((m) => isZeroOrAbsent(r[m])));
}

/**
 * K9: an interval=total read over a long range with no dimensions can answer
 * one all-zero row while monthly buckets carry data. True when the query has
 * the shape that needs the monthly cross-check.
 */
export function zeroTotalCheckApplies(interval: Interval, dimensions: string[], days: number): boolean {
  return interval === "total" && dimensions.length === 0 && days > ZERO_TOTAL_CHECK_DAYS;
}

export function zeroTotalFailedMessage(metrics: string[], days: number, monthly: Row[]): string {
  return `The interval=total read failed: it answered 0 for ${list(metrics)} over ${days} days, but the same query by month returned non-zero values (1 extra request), so the total is not zero. SearchLight sometimes answers a long-range total with an all-zero row. The ${monthly.length} monthly row(s) are attached; do not add them up except spend, because a customer or job active in two months is counted in each. For an exact total, request a shorter range or check again later.`;
}

export function zeroTotalConfirmedNote(days: number): string {
  return `Every metric read 0 over ${days} days, so the same query was sent once by month to rule out a failed total read (1 extra request); the monthly rows are also zero. check_zero_total=false skips this.`;
}
