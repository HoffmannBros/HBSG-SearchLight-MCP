/**
 * Pure logic behind the comparison tools: placing a value inside a benchmark
 * distribution, and joining two periods' events rows on their dimensions.
 */
import type { DictionaryEntry } from "./client.js";
import type { Row } from "./csv.js";
import { LOWER_IS_BETTER, staticField } from "./fields.js";

export const PERCENTILES = ["p10", "p25", "p50", "p75", "p90"] as const;

export interface Standing {
  /** Where the raw value falls: "<p10", "p10-p25", ..., ">p90". */
  band: string;
  /** Direction-aware reading: "top 10%" is always the good end. */
  standing: string;
  /** value / industry benchmark, or null when the benchmark is 0 or missing. */
  vsBenchmark: number | null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Place `value` in the p10..p90 distribution. Percentiles are read in the
 * metric's own direction: for costs and cancel rates, low is good, so a value
 * under p10 is "top 10%".
 */
export function benchmarkStanding(
  value: number,
  distribution: Partial<Record<(typeof PERCENTILES)[number] | "benchmark", number | null>>,
  lowerIsBetter: boolean,
): Standing | null {
  const p = PERCENTILES.map((k) => distribution[k]);
  if (p.some((x) => x === undefined || x === null)) return null;
  const [p10, p25, p50, p75, p90] = p as number[] as [number, number, number, number, number];

  let band: string;
  if (value < p10) band = "<p10";
  else if (value < p25) band = "p10-p25";
  else if (value < p50) band = "p25-p50";
  else if (value < p75) band = "p50-p75";
  else if (value <= p90) band = "p75-p90";
  else band = ">p90";

  let standing: string;
  if (!lowerIsBetter) {
    if (value > p90) standing = "top 10%";
    else if (value >= p75) standing = "top 25%";
    else if (value >= p50) standing = "better than median";
    else if (value >= p25) standing = "worse than median";
    else if (value >= p10) standing = "bottom 25%";
    else standing = "bottom 10%";
  } else {
    if (value < p10) standing = "top 10%";
    else if (value <= p25) standing = "top 25%";
    else if (value <= p50) standing = "better than median";
    else if (value <= p75) standing = "worse than median";
    else if (value <= p90) standing = "bottom 25%";
    else standing = "bottom 10%";
  }

  const bench = toNumber(distribution.benchmark);
  return { band, standing, vsBenchmark: bench ? value / bench : null };
}

export function isLowerBetter(metric: string): boolean {
  return LOWER_IS_BETTER.has(metric);
}

/**
 * Split requested fields into dimensions and metrics the way the API does:
 * a known metric is computed, anything else is grouped by. The live `/api`
 * dictionary wins; the bundled reference covers the case where it is absent.
 */
export function classifyFields(
  fields: string[],
  dictionary: Record<string, DictionaryEntry> | undefined,
): { dimensions: string[]; metrics: string[] } {
  const dimensions: string[] = [];
  const metrics: string[] = [];
  for (const f of fields) {
    const type = dictionary?.[f]?.type ?? staticField(f)?.type;
    (type === "metric" ? metrics : dimensions).push(f);
  }
  return { dimensions, metrics };
}

/**
 * Join two periods' rows on their dimension values. For each metric `m` the
 * output carries `m` (current), `m_prev`, `m_change` (current minus previous)
 * and `m_pct` (change over |previous|, null when previous is 0). A row present
 * in only one period gets null on the other side. Current-period order is
 * kept, with rows seen only in the previous period appended.
 */
export function joinPeriods(current: Row[], previous: Row[], dimensions: string[], metrics: string[]): Row[] {
  const keyOf = (r: Row) => JSON.stringify(dimensions.map((d) => r[d] ?? null));
  const prevByKey = new Map<string, Row>();
  for (const r of previous) prevByKey.set(keyOf(r), r);

  const out: Row[] = [];
  const seen = new Set<string>();
  const build = (cur: Row | undefined, prev: Row | undefined): Row => {
    const base = cur ?? prev ?? {};
    const row: Row = {};
    for (const d of dimensions) row[d] = base[d] ?? null;
    for (const m of metrics) {
      const c = cur ? toNumber(cur[m]) : null;
      const p = prev ? toNumber(prev[m]) : null;
      row[m] = c;
      row[`${m}_prev`] = p;
      row[`${m}_change`] = c !== null && p !== null ? c - p : null;
      row[`${m}_pct`] = c !== null && p !== null && p !== 0 ? (c - p) / Math.abs(p) : null;
    }
    return row;
  };

  for (const r of current) {
    const key = keyOf(r);
    seen.add(key);
    out.push(build(r, prevByKey.get(key)));
  }
  for (const [key, r] of prevByKey) {
    if (!seen.has(key)) out.push(build(undefined, r));
  }
  return out;
}

/** Column order for a joined table. */
export function joinedColumns(dimensions: string[], metrics: string[]): string[] {
  return [...dimensions, ...metrics.flatMap((m) => [m, `${m}_prev`, `${m}_change`, `${m}_pct`])];
}

/** Sort by the absolute change of one metric, largest first; nulls last. */
export function sortByChange(rows: Row[], metric: string): Row[] {
  const mag = (r: Row) => {
    const v = toNumber(r[`${metric}_change`]);
    return v === null ? -1 : Math.abs(v);
  };
  return [...rows].sort((a, b) => mag(b) - mag(a));
}
