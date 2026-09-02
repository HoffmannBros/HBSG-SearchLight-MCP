/**
 * Date-window arithmetic for the events endpoint. All math is done on UTC
 * calendar days so DST never shifts a boundary.
 */

export const INTERVALS = ["total", "month", "week", "day"] as const;
export type Interval = (typeof INTERVALS)[number];

/** The attribution window; a single interval may not exceed this many days. */
export const MAX_INTERVAL_DAYS = 90;

export interface DateWindow {
  start: string;
  end: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export class DateError extends Error {
  override name = "DateError";
}

export function parseIsoDate(value: string, label = "date"): number {
  const m = ISO_DATE.exec(value);
  if (!m) throw new DateError(`${label} must be YYYY-MM-DD, got "${value}".`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new DateError(`${label} "${value}" is not a real calendar date.`);
  }
  return ms;
}

export function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(ms: number, days: number): number {
  return ms + days * DAY_MS;
}

/** Number of calendar days from start to end, both inclusive. */
export function daysInclusive(start: string, end: string): number {
  const s = parseIsoDate(start, "start");
  const e = parseIsoDate(end, "end");
  if (e < s) throw new DateError(`end (${end}) is before start (${start}).`);
  return Math.round((e - s) / DAY_MS) + 1;
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfNextMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Monday-based week start, matching SearchLight's `week` dimension. */
function startOfWeek(ms: number): number {
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  const offset = (dow + 6) % 7; // days since Monday
  return addDays(ms, -offset);
}

/**
 * The sub-ranges the API computes for `interval` over [start, end], clipped
 * to the requested range. `total` yields the range itself.
 */
export function intervalBoundaries(start: string, end: string, interval: Interval): DateWindow[] {
  const s = parseIsoDate(start, "start");
  const e = parseIsoDate(end, "end");
  if (e < s) throw new DateError(`end (${end}) is before start (${start}).`);
  if (interval === "total") return [{ start, end }];

  const out: DateWindow[] = [];
  let cursor = s;
  while (cursor <= e) {
    let next: number;
    if (interval === "month") next = startOfNextMonth(cursor);
    else if (interval === "week") next = addDays(startOfWeek(cursor), 7);
    else next = addDays(cursor, 1);
    const last = Math.min(addDays(next, -1), e);
    out.push({ start: formatIsoDate(cursor), end: formatIsoDate(last) });
    cursor = next;
  }
  return out;
}

/**
 * Split a window into two halves at an interval boundary near the middle.
 * Returns null when the window is already a single interval (or `total`),
 * meaning it cannot be split further by date.
 */
export function halveWindow(window: DateWindow, interval: Interval): [DateWindow, DateWindow] | null {
  if (interval === "total") return null;
  const parts = intervalBoundaries(window.start, window.end, interval);
  if (parts.length < 2) return null;
  const mid = Math.ceil(parts.length / 2);
  const firstHalf = parts.slice(0, mid);
  const secondHalf = parts.slice(mid);
  return [
    { start: firstHalf[0]!.start, end: firstHalf[firstHalf.length - 1]!.end },
    { start: secondHalf[0]!.start, end: secondHalf[secondHalf.length - 1]!.end },
  ];
}

/** Whole calendar months from `from` to `to` inclusive, as YYYY-MM strings. */
export function monthRange(from: string, to: string): string[] {
  const re = /^(\d{4})-(\d{2})$/;
  const a = re.exec(from);
  const b = re.exec(to);
  if (!a || !b) throw new DateError(`months must be YYYY-MM, got "${from}" and "${to}".`);
  let cursor = Date.UTC(Number(a[1]), Number(a[2]) - 1, 1);
  const last = Date.UTC(Number(b[1]), Number(b[2]) - 1, 1);
  if (last < cursor) throw new DateError(`end_month (${to}) is before start_month (${from}).`);
  const out: string[] = [];
  while (cursor <= last) {
    out.push(formatIsoDate(cursor).slice(0, 7));
    cursor = startOfNextMonth(startOfMonth(cursor));
  }
  return out;
}

/** True for the events endpoint of any organization, e.g. /api/acme/events. */
export function isEventsPath(path: string): boolean {
  return /^\/api\/[^/]+\/events\/?$/.test(path.split("?")[0] ?? "");
}

/**
 * The events endpoint rejects any range longer than MAX_INTERVAL_DAYS unless a
 * sub-interval splits it, and each rejection costs a request against the
 * per-user hourly limit. Returns the message to fail with, or null when the
 * request is fine or we cannot tell (unparseable or partial range).
 */
export function eventsRangeViolation(params: {
  start?: unknown;
  end?: unknown;
  interval?: unknown;
}): string | null {
  const interval = params.interval === undefined || params.interval === null ? "total" : String(params.interval);
  if (interval !== "total") return null;
  if (typeof params.start !== "string" || typeof params.end !== "string") return null;
  let days: number;
  try {
    days = daysInclusive(params.start, params.end);
  } catch {
    return null; // Let the API speak for a range we cannot parse.
  }
  if (days <= MAX_INTERVAL_DAYS) return null;
  return `Requested range spans ${days} days, exceeding SearchLight's ${MAX_INTERVAL_DAYS}-day attribution window. Pass interval=month, week, or day to split it, or shorten the range. Not sent, so it cost no API call.`;
}
