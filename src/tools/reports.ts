/**
 * Report tools: a fixed performance table (spend through ROAS, with projected
 * revenue) and a customer funnel, each built from a few aggregate events
 * requests. They exist so nobody rebuilds the same field list by hand and then
 * adds sold and closed revenue in a spreadsheet. Every request uses
 * interval=total over 90 days or less, the only shape where the API's totals
 * are exact (K5).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchEventsChunked, type ChunkStats, type EventsQuery } from "../chunking.js";
import { toNumber } from "../compare.js";
import type { AppContext } from "../context.js";
import { resolveScope } from "../context.js";
import { RowSpool, sanitizeFilename, type Row } from "../csv.js";
import { DateError, MAX_INTERVAL_DAYS, daysInclusive, localToday } from "../dates.js";
import { METRIC_GUIDE } from "../fields.js";
import { filtersToParams, type Filters } from "../filters.js";
import { formatBytes, inferColumns, limitRows, markdownTable, textResult } from "../format.js";
import {
  ACCOUNT_DIMENSIONS,
  NO_TRACKED_EVENTS,
  RowGuard,
  reconcileSpend,
  spendReconciliationFields,
  unattributedSpendRows,
  type SpendReconciliation,
} from "../guards.js";
import {
  READ_ONLY,
  accountArg,
  accountsArg,
  bomArg,
  dateArg,
  filenameArg,
  filtersArg,
  formatArg,
  guarded,
  organizationArg,
  outputDirArg,
  pickAccounts,
  resolveOutputDir,
  subsetArg,
  withExtension,
} from "./common.js";

/* ---------- Shared ---------- */

/** Metrics of the performance report, in output order. No grading metrics (K4). */
export const PERFORMANCE_METRICS = [
  "spend",
  "leads",
  "bookedCustomers",
  "payingCustomers",
  "soldRevenue",
  "closedRevenue",
  "bookRate",
  "avgCostPerLead",
  "roasClosed",
] as const;

/** Performance metrics that add up across the rows of one total (cross-checked against the totals request). */
export const ADDITIVE_PERFORMANCE_METRICS = ["spend", "leads", "bookedCustomers", "payingCustomers", "soldRevenue", "closedRevenue"] as const;

/** Columns computed here from each row's own numbers. */
export const COMPUTED_COLUMNS = ["projectedRevenue", "roasProjected"] as const;

export const PERFORMANCE_DIMENSIONS = ["account", "attributionCategory", "attributionChannel", "campaign", "normalizedBusinessUnit", "businessUnit"] as const;

/** Request A of the funnel report: stage counts and step rates. */
export const FUNNEL_RATE_METRICS = [
  "customers",
  "bookedCustomers",
  "payingCustomers",
  "canceledCustomers",
  "stepBookRate",
  "stepEstimateRate",
  "stepSoldRate",
  "stepCloseRate",
  "customerCancelRate",
] as const;

/** Request B of the funnel report, split by adjustedType. */
export const FUNNEL_STAGE_METRICS = ["customers", "estimatedRevenue", "soldRevenue", "closedRevenue"] as const;

export const FUNNEL_DIMENSIONS = ["account", "attributionCategory", "attributionChannel", "normalizedBusinessUnit"] as const;

/**
 * The adjustedType values in funnel order (live 2026-11-11: exactly these six),
 * with the step rate into each stage and the revenue held at it.
 */
export const FUNNEL_STAGES: ReadonlyArray<{ stage: string; rate: string | null; revenue: string | null }> = [
  { stage: "lead-originated", rate: null, revenue: null },
  { stage: "booked", rate: "stepBookRate", revenue: null },
  { stage: "estimated", rate: "stepEstimateRate", revenue: "estimatedRevenue" },
  { stage: "sold", rate: "stepSoldRate", revenue: "soldRevenue" },
  { stage: "closed", rate: "stepCloseRate", revenue: "closedRevenue" },
  { stage: "canceled", rate: "customerCancelRate", revenue: null },
];

export const NO_SPEND = "n/a (no spend)";
export const UNTRACKED_SPEND_LABEL = "spend with no tracked events";
export const TOTAL_LABEL = "Total";
const CLOSED_LAG_DAYS = 35;

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Refuse a range the report cannot answer as one exact total, before anything is sent. */
export function checkReportRange(start: string, end: string): number {
  const days = daysInclusive(start, end);
  if (days > MAX_INTERVAL_DAYS) {
    throw new DateError(
      `The range is ${days} days; this report is one exact total and SearchLight limits a total to ${MAX_INTERVAL_DAYS} days. Shorten the range, or run the report once per period of ${MAX_INTERVAL_DAYS} days or less (do not add the periods' revenue or customers together), or use searchlight_query_events with an interval.`,
    );
  }
  return days;
}

/** The closed-revenue lag caveat when the range ends within 35 days of today. */
export function closedLagNote(end: string, today: string = localToday()): string | null {
  if (end > today) return `closedRevenue: the range ends after today (${today}). ${METRIC_GUIDE.closedRevenue}`;
  const daysSinceEnd = daysInclusive(end, today) - 1;
  if (daysSinceEnd >= CLOSED_LAG_DAYS) return null;
  return `closedRevenue and roasClosed: the range ends ${daysSinceEnd} day(s) ago. ${METRIC_GUIDE.roasClosed} projectedRevenue (sold + closed) is the better read for recent work.`;
}

/**
 * Add projectedRevenue and roasProjected to a row, and replace roasClosed with
 * "n/a (no spend)" when spend is zero. Mutates and returns the row.
 */
export function addComputedColumns(row: Row): Row {
  const sold = toNumber(row.soldRevenue) ?? 0;
  const closed = toNumber(row.closedRevenue) ?? 0;
  const spend = toNumber(row.spend) ?? 0;
  const projected = round2(sold + closed);
  row.projectedRevenue = projected;
  if (spend > 0) {
    row.roasProjected = Math.round((projected / spend) * 1e4) / 1e4;
  } else {
    row.roasProjected = NO_SPEND;
    row.roasClosed = NO_SPEND;
  }
  return row;
}

function sortValue(v: unknown): number {
  const n = toNumber(v);
  return n === null ? Number.NEGATIVE_INFINITY : n;
}

const scopeArgs = {
  organization: organizationArg,
  subset: subsetArg,
  account: accountArg,
  accounts: accountsArg,
  start: dateArg("Start"),
  end: dateArg(`End (the range is one total, ${MAX_INTERVAL_DAYS} days or less)`),
  filters: filtersArg,
};

async function reportScope(ctx: AppContext, args: { organization?: string | undefined; subset?: string | undefined; account?: string | undefined; accounts?: string[] | undefined }) {
  return resolveScope(ctx, args.organization, pickAccounts(args.account, args.accounts), args.subset);
}

async function fetchAll(ctx: AppContext, query: EventsQuery): Promise<{ rows: Row[]; stats: ChunkStats }> {
  const rows: Row[] = [];
  const stats = await fetchEventsChunked(ctx.client, query, async (chunk) => {
    rows.push(...chunk);
  });
  return { rows, stats };
}

/* ---------- Performance report ---------- */

export interface PerformanceResult {
  rows: Row[];
  untracked: Row[];
  totals: Row;
  reconciliation: SpendReconciliation;
  mismatches: Array<{ metric: string; rows: number; total: number }>;
  droppedPlaceholders: number;
}

/**
 * Build the performance table from the split rows, the unsplit totals row(s),
 * and (when `by` has an account dimension beside another split) the
 * per-account spend rows.
 */
export function buildPerformance(
  by: string[],
  splitRows: Row[],
  totalsRows: Row[],
  accountSpendRows: Row[] | null,
  sortBy: string,
): PerformanceResult {
  const guard = new RowGuard({
    dimensions: by,
    metrics: [...PERFORMANCE_METRICS],
    interval: "total",
    start: "",
    end: "",
    dropPlaceholders: true,
    filterFields: [],
  });
  const kept = guard.accept(splitRows);
  const droppedPlaceholders = splitRows.length - kept.length;

  const accountFields = accountSpendRows ? ACCOUNT_DIMENSIONS.filter((d) => by.includes(d)) : [];
  const reconciliation = reconcileSpend(kept, accountSpendRows ?? totalsRows, [...accountFields]);

  const rows = kept.map((r) => addComputedColumns({ ...r }));
  rows.sort((a, b) => sortValue(b[sortBy]) - sortValue(a[sortBy]));

  const untracked = unattributedSpendRows(reconciliation, by).map((r) => {
    for (const d of by) if (r[d] === NO_TRACKED_EVENTS) r[d] = `(${UNTRACKED_SPEND_LABEL})`;
    return r;
  });

  const totals: Row = Object.fromEntries(by.map((d) => [d, TOTAL_LABEL]));
  const t = totalsRows[0] ?? {};
  for (const m of PERFORMANCE_METRICS) totals[m] = t[m] ?? null;
  addComputedColumns(totals);

  const mismatches: PerformanceResult["mismatches"] = [];
  for (const m of ADDITIVE_PERFORMANCE_METRICS) {
    if (m === "spend") continue; // reconciled above
    const total = toNumber(t[m]);
    if (total === null) continue;
    const sum = round2(kept.reduce((s, r) => s + (toNumber(r[m]) ?? 0), 0));
    if (Math.abs(sum - total) > 0.01) mismatches.push({ metric: m, rows: sum, total });
  }
  return { rows, untracked, totals, reconciliation, mismatches, droppedPlaceholders };
}

/** The spend check, always shown; says which request the total came from. */
export function untrackedSpendNote(rec: SpendReconciliation, perAccountRequest: boolean): string {
  const source = perAccountRequest ? "1 extra request for spend by account" : "the totals request";
  if (rec.missing <= 0) return `Spend check: the rows carry all ${MONEY.format(rec.total)} of spend (checked against ${source}).`;
  const share = rec.total > 0 ? ` (${((rec.missing / rec.total) * 100).toFixed(1)}%)` : "";
  const short = (rec.byAccount ?? []).filter((a) => a.missing > 0);
  const per = short.length > 0 ? ` By account: ${short.map((a) => `${String(a.account ?? a.accountKey)} ${MONEY.format(a.missing)} of ${MONEY.format(a.total)}`).join("; ")}.` : "";
  return `Spend with no tracked events: ${MONEY.format(rec.missing)} of ${MONEY.format(rec.total)} total spend${share} is in no row, because SearchLight only returns a dimension combination that has at least one tracked event (found by comparing with ${source}). The "${UNTRACKED_SPEND_LABEL}" line carries it, so the spend column adds up to the total.${per}`;
}

function mismatchNote(mismatches: PerformanceResult["mismatches"], by: string[]): string | null {
  if (mismatches.length === 0) return null;
  const parts = mismatches.map((m) => `${m.metric} rows ${m.rows.toLocaleString("en-US")} vs total ${m.total.toLocaleString("en-US")}`);
  return `The rows do not add up to the totals line for ${parts.join("; ")}. A customer can fall under more than one ${by.join("/")} value, or under none, so the split counts them differently; the totals line (a separate unsplit request) is the figure for the whole range.`;
}

const performanceColumns = (by: string[]) => [...by, ...PERFORMANCE_METRICS.slice(0, 6), "projectedRevenue", ...PERFORMANCE_METRICS.slice(6), "roasProjected"];

const SORTABLE = [...PERFORMANCE_METRICS, ...COMPUTED_COLUMNS] as const;

/* ---------- Funnel report ---------- */

export interface FunnelGroup {
  key: Row;
  summary: Row;
  stages: Row[];
}

function groupKey(row: Row, by: string | undefined): string {
  return by ? JSON.stringify(row[by] ?? null) : "all";
}

/** Build one funnel per `by` value from request A (rates) and request B (split by adjustedType). */
export function buildFunnel(by: string | undefined, rateRows: Row[], stageRows: Row[]): { groups: FunnelGroup[]; mismatches: string[]; unknownStages: string[] } {
  const known = new Set(FUNNEL_STAGES.map((s) => s.stage));
  const unknownStages = new Set<string>();
  const stagesBy = new Map<string, Map<string, Row>>();
  for (const r of stageRows) {
    const stage = r.adjustedType;
    if (typeof stage !== "string" || stage.trim() === "" || stage === "N/A") {
      // K7 placeholder: no stage. Keep it only if it carries customers.
      if ((toNumber(r.customers) ?? 0) === 0) continue;
    }
    const k = groupKey(r, by);
    if (!stagesBy.has(k)) stagesBy.set(k, new Map());
    const name = typeof stage === "string" && stage.trim() !== "" ? stage : "(no stage)";
    if (!known.has(name)) unknownStages.add(name);
    stagesBy.get(k)!.set(name, r);
  }

  const rateBy = new Map<string, Row>();
  for (const r of rateRows) {
    if (by && (r[by] === undefined || r[by] === null || r[by] === "") && FUNNEL_RATE_METRICS.every((m) => (toNumber(r[m]) ?? 0) === 0)) continue;
    rateBy.set(groupKey(r, by), r);
  }

  const keys = [...new Set([...rateBy.keys(), ...stagesBy.keys()])];
  const groups: FunnelGroup[] = [];
  const mismatches: string[] = [];
  for (const k of keys) {
    const rates = rateBy.get(k) ?? {};
    const stages = stagesBy.get(k) ?? new Map<string, Row>();
    const keyRow: Row = by ? { [by]: (rates[by] ?? [...stages.values()][0]?.[by]) ?? null } : {};
    const summary: Row = { ...keyRow };
    for (const m of FUNNEL_RATE_METRICS) summary[m] = rates[m] ?? null;

    const order = [...FUNNEL_STAGES.map((s) => s.stage), ...[...stages.keys()].filter((s) => !known.has(s))];
    const out: Row[] = [];
    for (const stage of order) {
      const def = FUNNEL_STAGES.find((s) => s.stage === stage);
      const row = stages.get(stage);
      out.push({
        ...keyRow,
        stage,
        customers: toNumber(row?.customers) ?? 0,
        stepRate: def?.rate ? (rates[def.rate] ?? null) : null,
        stepRateMetric: def?.rate ?? null,
        revenue: def?.revenue ? (toNumber(row?.[def.revenue]) ?? 0) : null,
      });
    }
    const atStages = out.reduce((s, r) => s + (toNumber(r.customers) ?? 0), 0);
    const all = toNumber(rates.customers);
    if (all !== null && Math.abs(atStages - all) > 0.5) {
      mismatches.push(`${by ? `${by} ${String(keyRow[by])}: ` : ""}stages hold ${atStages} customers, the unsplit count is ${all}`);
    }
    groups.push({ key: keyRow, summary, stages: out });
  }
  groups.sort((a, b) => sortValue(b.summary.customers) - sortValue(a.summary.customers));
  return { groups, mismatches, unknownStages: [...unknownStages] };
}

const pct = (v: unknown) => {
  const n = toNumber(v);
  return n === null ? "" : `${(n * 100).toFixed(1)}%`;
};

function funnelTable(group: FunnelGroup): string {
  const rows = group.stages.map((s) => ({
    stage: s.stage,
    customers: s.customers,
    stepRate: s.stepRateMetric ? `${pct(s.stepRate)} (${String(s.stepRateMetric)})` : "",
    revenue: s.revenue === null ? "" : MONEY.format(toNumber(s.revenue) ?? 0),
  }));
  return markdownTable(rows, ["stage", "customers", "stepRate", "revenue"]);
}

/* ---------- Registration ---------- */

export function registerReportTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_performance_report",
    {
      title: "SearchLight performance report",
      description: `Standard performance table for one range of ${MAX_INTERVAL_DAYS} days or less: spend, leads, booked and paying customers, sold and closed revenue, projectedRevenue (sold + closed), book rate, cost per lead, roasClosed and roasProjected, split by one or two of ${PERFORMANCE_DIMENSIONS.join(", ")} (default attributionChannel). Adds a line for spend with no tracked events (which SearchLight leaves out of a split) and a totals line from a separate unsplit request. export=true also writes the rows to a CSV. Sends 2 or 3 aggregate requests.`,
      inputSchema: {
        ...scopeArgs,
        by: z
          .array(z.enum(PERFORMANCE_DIMENSIONS))
          .min(1)
          .max(2)
          .default(["attributionChannel"])
          .describe(`One or two dimensions to split by: ${PERFORMANCE_DIMENSIONS.join(", ")}. Default ["attributionChannel"].`),
        sort_by: z.enum(SORTABLE).default("spend").describe("Column to sort rows by, largest first. Default spend."),
        max_rows: z.number().int().min(1).max(2000).default(100).describe("Maximum rows to return inline. Default 100. The spend line and totals line are always shown."),
        export: z.boolean().default(false).describe("Also write the rows (and the spend-with-no-tracked-events rows) to a CSV in the export folder. Default false."),
        filename: filenameArg,
        output_dir: outputDirArg,
        format: formatArg,
        excel_bom: bomArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      checkReportRange(args.start, args.end);
      const by = [...new Set(args.by)];
      if (by.length !== args.by.length) throw new DateError(`by lists ${args.by.join(", ")}; give each dimension once.`);
      const extraParams = filtersToParams(args.filters as Filters | undefined);
      const scope = await reportScope(ctx, args);
      const notes = [...scope.notes];
      const base: EventsQuery = {
        organization: scope.organization,
        fields: [],
        start: args.start,
        end: args.end,
        interval: "total",
        accounts: scope.accounts,
        subset: scope.subset,
        extraParams,
      };
      // The per-account spend request applies only when an account dimension
      // sits beside another split; otherwise the unsplit totals request is the
      // spend to reconcile against.
      const recFields = spendReconciliationFields(by, [...PERFORMANCE_METRICS], "total");
      const accountSpendFields = recFields && recFields.length > 1 ? recFields : null;
      const [split, totals, accountSpend] = await Promise.all([
        fetchAll(ctx, { ...base, fields: [...by, ...PERFORMANCE_METRICS] }),
        fetchAll(ctx, { ...base, fields: [...PERFORMANCE_METRICS] }),
        accountSpendFields ? fetchAll(ctx, { ...base, fields: accountSpendFields }) : Promise.resolve(null),
      ]);
      for (const s of [split.stats, totals.stats, accountSpend?.stats]) if (s?.notes) notes.push(...s.notes);

      const result = buildPerformance(by, split.rows, totals.rows, accountSpend?.rows ?? null, args.sort_by);
      const rec = result.reconciliation;
      if (result.droppedPlaceholders > 0) {
        notes.push(`Dropped ${result.droppedPlaceholders} placeholder row(s) with every dimension blank and every metric 0; totals are unchanged.`);
      }
      notes.push(untrackedSpendNote(rec, accountSpendFields !== null));
      const mm = mismatchNote(result.mismatches, by);
      if (mm) notes.push(mm);
      notes.push(
        `projectedRevenue = soldRevenue + closedRevenue, computed here per row: the revenue expected to close from work sold so far (a customer is in only one of the two). roasProjected = projectedRevenue / spend. Both ROAS columns read "${NO_SPEND}" where spend is 0. The totals line comes from a separate unsplit request; rate columns are never added up.`,
      );
      const lag = closedLagNote(args.end);
      if (lag) notes.push(lag);

      let exported: { path: string; rows: number; bytes: number } | undefined;
      const columns = performanceColumns(by);
      if (args.export) {
        const spool = await RowSpool.create({ dir: resolveOutputDir(ctx, args.output_dir), initialColumns: columns });
        try {
          await spool.pushMany(result.rows);
          await spool.pushMany(result.untracked);
        } catch (err) {
          await spool.discard();
          throw err;
        }
        const baseName = args.filename?.trim() || `performance_${sanitizeFilename(scope.organization)}_${args.start}_${args.end}_${by.join("-")}`;
        const file = await spool.finalize(withExtension(sanitizeFilename(baseName), args.format), { format: args.format, bom: args.excel_bom });
        exported = { path: file.path, rows: file.rows, bytes: file.bytes };
        notes.push(
          `Wrote ${file.rows} row(s) to ${file.path} (${formatBytes(file.bytes)}), including ${result.untracked.length} "${UNTRACKED_SPEND_LABEL}" row(s) and no totals line, so the file's spend adds up to the total and a pivot does not count anything twice.`,
        );
      }

      const limited = limitRows(result.rows, args.max_rows);
      if (limited.truncated) notes.push(`Showing ${limited.rows.length} of ${limited.total} rows${exported ? "" : "; export=true writes them all"}.`);
      const apiCalls = ctx.client.requestCount - before;
      const shown = [...limited.rows, ...result.untracked, result.totals];
      const text = [
        `Performance for ${scope.organization}${scope.subset ? ` (subset ${scope.subset})` : ""}, ${args.start} to ${args.end}, by ${by.join(", ")}${scope.accounts ? `, accounts=${scope.accounts.join(",")}` : ""}: ${limited.total} row(s). ${apiCalls} API call(s), ${Date.now() - started} ms.`,
        ...notes,
        markdownTable(shown, inferColumns(shown, columns)),
      ].join("\n\n");
      return textResult(text, {
        organization: scope.organization,
        subset: scope.subset,
        accounts: scope.accounts,
        start: args.start,
        end: args.end,
        by,
        rowCount: limited.total,
        truncated: limited.truncated,
        rows: limited.rows,
        untrackedSpendRows: result.untracked,
        totals: result.totals,
        spendReconciliation: rec,
        ...(exported ? { export: exported } : {}),
        apiCalls,
        notes,
      });
    }),
  );

  server.registerTool(
    "searchlight_funnel_report",
    {
      title: "SearchLight funnel report",
      description: `Customer funnel for one range of ${MAX_INTERVAL_DAYS} days or less: for each stage (lead-originated, booked, estimated, sold, closed, canceled), the customers whose furthest stage it is, the step rate into it, and the revenue held there. Optionally one funnel per value of ${FUNNEL_DIMENSIONS.join(", ")}. Sends 2 aggregate requests.`,
      inputSchema: {
        ...scopeArgs,
        by: z.enum(FUNNEL_DIMENSIONS).optional().describe(`Optional: one funnel per value of ${FUNNEL_DIMENSIONS.join(", ")}.`),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      checkReportRange(args.start, args.end);
      const extraParams = filtersToParams(args.filters as Filters | undefined);
      const scope = await reportScope(ctx, args);
      const notes = [...scope.notes];
      const base: EventsQuery = {
        organization: scope.organization,
        fields: [],
        start: args.start,
        end: args.end,
        interval: "total",
        accounts: scope.accounts,
        subset: scope.subset,
        extraParams,
      };
      const dims = args.by ? [args.by] : [];
      const [rates, stages] = await Promise.all([
        fetchAll(ctx, { ...base, fields: [...dims, ...FUNNEL_RATE_METRICS] }),
        fetchAll(ctx, { ...base, fields: [...dims, "adjustedType", ...FUNNEL_STAGE_METRICS] }),
      ]);
      for (const s of [rates.stats, stages.stats]) if (s.notes) notes.push(...s.notes);
      const { groups, mismatches, unknownStages } = buildFunnel(args.by, rates.rows, stages.rows);

      notes.push(
        "customers is the count whose furthest stage in the range is that stage (adjustedType), so the stages add up to all customers. stepRate is SearchLight's cohort rate into the stage (for example stepBookRate: of leads originated in the range, the fraction eventually booked), not a ratio of the counts shown. revenue is what those customers hold at that stage: estimated, sold or closed revenue.",
      );
      if (mismatches.length > 0) notes.push(`Stage counts do not add up to the unsplit customer count: ${mismatches.join("; ")}.`);
      if (unknownStages.length > 0) notes.push(`adjustedType returned stage value(s) this report does not know: ${unknownStages.join(", ")}. They are listed after the known stages with no step rate.`);
      const lag = closedLagNote(args.end);
      if (lag) notes.push(lag);

      const apiCalls = ctx.client.requestCount - before;
      const sections = groups.map((g) => {
        const s = g.summary;
        const head = args.by ? `### ${args.by}: ${String(g.key[args.by] ?? "(blank)")}\n\n` : "";
        return `${head}customers ${String(s.customers ?? "")}, booked ${String(s.bookedCustomers ?? "")}, paying ${String(s.payingCustomers ?? "")}, canceled ${String(s.canceledCustomers ?? "")}.\n\n${funnelTable(g)}`;
      });
      const text = [
        `Funnel for ${scope.organization}${scope.subset ? ` (subset ${scope.subset})` : ""}, ${args.start} to ${args.end}${args.by ? `, by ${args.by}` : ""}${scope.accounts ? `, accounts=${scope.accounts.join(",")}` : ""}: ${groups.length} funnel(s). ${apiCalls} API call(s), ${Date.now() - started} ms.`,
        ...notes,
        ...(sections.length > 0 ? sections : ["(no rows)"]),
      ].join("\n\n");
      return textResult(text, {
        organization: scope.organization,
        subset: scope.subset,
        accounts: scope.accounts,
        start: args.start,
        end: args.end,
        by: args.by,
        funnels: groups.map((g) => ({ ...g.key, summary: g.summary, stages: g.stages })),
        apiCalls,
        notes,
      });
    }),
  );
}
