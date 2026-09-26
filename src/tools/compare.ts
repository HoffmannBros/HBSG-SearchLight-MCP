import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchEventsChunked, type EventsQuery } from "../chunking.js";
import { SearchLightApiError } from "../client.js";
import {
  PERCENTILES,
  benchmarkStanding,
  classifyFields,
  isLowerBetter,
  joinPeriods,
  joinedColumns,
  sortByChange,
  toNumber,
} from "../compare.js";
import type { AppContext } from "../context.js";
import { resolveScope } from "../context.js";
import type { Row } from "../csv.js";
import { DateError, MAX_INTERVAL_DAYS, daysInclusive, localToday, monthWindow, precedingWindow } from "../dates.js";
import { BENCHMARK_DIMENSIONS, BENCHMARK_METRICS, METRIC_GUIDE } from "../fields.js";
import { filtersToParams, type Filters } from "../filters.js";
import { inferColumns, limitRows, markdownTable, textResult } from "../format.js";
import { benchmarkFiltersArg, benchmarkParams, monthArg } from "./benchmarks.js";
import {
  READ_ONLY,
  accountArg,
  accountsArg,
  crossFilterArg,
  dateArg,
  fieldsArg,
  filtersArg,
  guarded,
  organizationArg,
  pickAccounts,
} from "./common.js";

const DEFAULT_BENCHMARK_METRICS = ["bookRate", "matchRate", "avgTicket", "avgCostPerLead", "roasClosed", "roasPotential"];

/** Metrics whose value means nothing when there was no spend. */
const SPEND_BASED = new Set([
  "avgCostPerLead",
  "avgCostPerPayingCustomer",
  "avgCostPerBookedCustomer",
  "roasPotential",
  "roasClosed",
]);

export function registerCompareTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_compare_to_benchmark",
    {
      title: "Compare accounts to the industry benchmark",
      description:
        "For one month, put each account's own numbers (from events) next to SearchLight's anonymized industry benchmark and its p10-p90 distribution, and say where each account stands. Standing reads in the metric's direction: for costs and cancel rates lower is better, so \"top 10%\" always means the good end. Optionally broken out by one benchmark dimension (e.g. attributionCategory), with the same dimension filters applied to both sides. Costs 2 API calls. The current month and previous-mtd are month-to-date.",
      inputSchema: {
        organization: organizationArg,
        month: monthArg,
        metrics: z
          .array(z.enum(BENCHMARK_METRICS))
          .min(1)
          .optional()
          .describe(`Benchmark metrics to compare. Default: ${DEFAULT_BENCHMARK_METRICS.join(", ")}.`),
        dimension: z
          .enum(BENCHMARK_DIMENSIONS)
          .optional()
          .describe("Break both sides out by this dimension; each value is compared to its own benchmark segment."),
        by_account: z.boolean().default(true).describe("One comparison per account (default). False compares the accounts combined."),
        account: accountArg,
        accounts: accountsArg,
        filters: benchmarkFiltersArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const metrics: string[] = args.metrics ? [...new Set(args.metrics)] : DEFAULT_BENCHMARK_METRICS;
      const dim = args.dimension;
      const today = localToday();
      const window = monthWindow(args.month, today);
      // Validates the filters (benchmark dimensions only) before anything is sent.
      benchmarkParams([], args.filters, undefined);
      const scope = await resolveScope(ctx, args.organization, pickAccounts(args.account, args.accounts));
      const benchParams = benchmarkParams([...(dim ? [dim] : []), ...metrics], args.filters, scope.accounts);
      const notes = [...scope.notes];

      const needSpend = metrics.some((m) => SPEND_BASED.has(m));
      const eventFields = [
        ...(args.by_account ? ["accountKey", "account"] : []),
        ...(dim ? [dim] : []),
        ...metrics,
        ...(needSpend ? ["spend"] : []),
      ];
      const query: EventsQuery = {
        organization: scope.organization,
        fields: eventFields,
        start: window.start,
        end: window.end,
        interval: "total",
        accounts: scope.accounts,
        extraParams: filtersToParams(args.filters as Filters | undefined),
      };
      const benchPath = `/api/${encodeURIComponent(scope.organization)}/benchmarks`;

      const eventRows: Row[] = [];
      const [, benchRows] = await Promise.all([
        fetchEventsChunked(ctx.client, query, async (chunk) => {
          eventRows.push(...chunk);
        }),
        ctx.client
          .get<Row[]>(benchPath, { ...benchParams, month: args.month })
          .catch((err: unknown) => {
            if (err instanceof SearchLightApiError && err.status === 503) {
              notes.push(`Benchmark data for ${args.month} is still being gathered, so only your own numbers are shown. Retry in a few minutes.`);
              return null;
            }
            throw err;
          }),
      ]);

      // Benchmark rows indexed by dimension value, then by series.
      const segments = new Map<string, Map<string, Row>>();
      for (const r of benchRows ?? []) {
        const key = dim ? String(r[dim] ?? "") : "";
        const series = String(r.series ?? "");
        if (!segments.has(key)) segments.set(key, new Map());
        segments.get(key)!.set(series, r);
      }
      if (benchRows && benchRows.length === 0) {
        notes.push("The benchmark came back empty: SearchLight withholds segments with too few accounts. Remove a filter or the dimension for a larger cohort.");
      }

      const missingSegments = new Set<string>();
      const rows: Row[] = [];
      for (const ev of eventRows) {
        const key = dim ? String(ev[dim] ?? "") : "";
        const seg = segments.get(key);
        if (benchRows && benchRows.length > 0 && !seg) missingSegments.add(key);
        const noSpend = needSpend && toNumber(ev.spend) === 0;
        for (const m of metrics) {
          const value = toNumber(ev[m]);
          const dist: Record<string, number | null> = { benchmark: toNumber(seg?.get("benchmark")?.[m]) };
          for (const p of PERCENTILES) dist[p] = toNumber(seg?.get(p)?.[m]);
          let band = "";
          let standing = "";
          let vs: number | null = null;
          if (noSpend && SPEND_BASED.has(m)) {
            standing = "n/a (no spend)";
          } else if (value !== null) {
            const s = benchmarkStanding(value, dist, isLowerBetter(m));
            if (s) ({ band, standing, vsBenchmark: vs } = s);
          }
          rows.push({
            ...(args.by_account ? { account: ev.account, accountKey: ev.accountKey } : {}),
            ...(dim ? { [dim]: ev[dim] } : {}),
            metric: m,
            value,
            benchmark: dist.benchmark,
            ...Object.fromEntries(PERCENTILES.map((p) => [p, dist[p]])),
            band,
            standing,
            vs_benchmark: vs,
            cohortAccounts: toNumber(seg?.get("benchmark")?.cohortAccounts),
            ...(needSpend ? { spend: toNumber(ev.spend) } : {}),
          });
        }
      }
      if (missingSegments.size > 0) {
        notes.push(`No benchmark segment for ${[...missingSegments].map((k) => `"${k}"`).join(", ")} (too few accounts, or not a benchmarked value); those rows have no standing.`);
      }

      notes.push(
        window.partial
          ? `Your numbers cover ${window.start} to ${window.end} (month to date through today on this computer); the benchmark for ${args.month} is SearchLight's own month-to-date, which may end a day earlier.`
          : `Your numbers cover ${window.start} to ${window.end}.`,
      );
      const daysSinceEnd = daysInclusive(window.end, today) - 1;
      if (metrics.includes("roasClosed") && daysSinceEnd < 35) {
        notes.push(`roasClosed: ${METRIC_GUIDE.roasClosed}`);
      }
      if (metrics.includes("matchRate")) {
        notes.push(`matchRate: ${METRIC_GUIDE.matchRate}`);
      }

      const apiCalls = ctx.client.requestCount - before;
      const columns = [
        ...(args.by_account ? ["account"] : []),
        ...(dim ? [dim] : []),
        "metric",
        "value",
        "benchmark",
        ...PERCENTILES,
        "standing",
        "cohortAccounts",
      ];
      const text = [
        `${rows.length} comparison(s) for ${scope.organization}, ${args.month}. ${apiCalls} API call(s), ${Date.now() - started} ms.`,
        ...notes,
        markdownTable(rows, columns),
      ].join("\n\n");
      return textResult(text, {
        organization: scope.organization,
        month: args.month,
        start: window.start,
        end: window.end,
        rowCount: rows.length,
        rows,
        apiCalls,
        notes,
      });
    }),
  );

  server.registerTool(
    "searchlight_compare_periods",
    {
      title: "Compare two SearchLight periods",
      description:
        "Run the same events query over two date ranges and join the rows on their dimension values, with each metric's current value, previous value, change, and percent change (m, m_prev, m_change, m_pct). The comparison range defaults to the same number of days immediately before start. Rates are decimals, so a bookRate change of 0.05 is 5 points; m_pct is relative change. A row present in only one period has nulls on the other side. Each range is limited to 90 days. Costs at least 2 API calls.",
      inputSchema: {
        organization: organizationArg,
        fields: fieldsArg,
        start: dateArg("Current period start"),
        end: dateArg("Current period end"),
        compare_start: z.string().optional().describe("Comparison period start, YYYY-MM-DD. Give with compare_end, or omit both for the preceding period of equal length."),
        compare_end: z.string().optional().describe("Comparison period end, YYYY-MM-DD."),
        account: accountArg,
        accounts: accountsArg,
        filters: filtersArg,
        filter: crossFilterArg,
        sort_by: z.string().optional().describe("A metric from fields; sorts rows by the absolute size of its change, largest first."),
        max_rows: z.number().int().min(1).max(2000).default(200).describe("Maximum rows to return inline. Default 200, max 2000."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      if ((args.compare_start === undefined) !== (args.compare_end === undefined)) {
        throw new DateError("Give both compare_start and compare_end, or neither.");
      }
      const current = { start: args.start, end: args.end };
      const previous =
        args.compare_start !== undefined && args.compare_end !== undefined
          ? { start: args.compare_start, end: args.compare_end }
          : precedingWindow(args.start, args.end);
      for (const [label, w] of [["The current period", current], ["The comparison period", previous]] as const) {
        const days = daysInclusive(w.start, w.end);
        if (days > MAX_INTERVAL_DAYS) {
          throw new DateError(`${label} is ${days} days; each period is one total and limited to ${MAX_INTERVAL_DAYS} days by SearchLight's attribution window.`);
        }
      }

      const extraParams = filtersToParams(args.filters as Filters | undefined, args.filter);
      const scope = await resolveScope(ctx, args.organization, pickAccounts(args.account, args.accounts));
      const access = await ctx.client.getAccess().catch(() => undefined);
      const { dimensions, metrics } = classifyFields(args.fields, access?.dictionary);
      if (metrics.length === 0) {
        throw new Error(`fields must include at least one metric; none of ${args.fields.join(", ")} is a known metric. Use searchlight_list_fields to find metric names.`);
      }
      if (args.sort_by !== undefined && !metrics.includes(args.sort_by)) {
        throw new Error(`sort_by must be one of the requested metrics: ${metrics.join(", ")}.`);
      }

      const base = { organization: scope.organization, fields: args.fields, interval: "total" as const, accounts: scope.accounts, extraParams };
      const curRows: Row[] = [];
      const prevRows: Row[] = [];
      const [curStats, prevStats] = await Promise.all([
        fetchEventsChunked(ctx.client, { ...base, ...current }, async (chunk) => {
          curRows.push(...chunk);
        }),
        fetchEventsChunked(ctx.client, { ...base, ...previous }, async (chunk) => {
          prevRows.push(...chunk);
        }),
      ]);

      let joined = joinPeriods(curRows, prevRows, dimensions, metrics);
      if (args.sort_by) joined = sortByChange(joined, args.sort_by);
      const limited = limitRows(joined, args.max_rows);
      const notes = [...scope.notes];
      const onlyCurrent = joined.filter((r) => metrics.every((m) => r[`${m}_prev`] === null) && metrics.some((m) => r[m] !== null)).length;
      const onlyPrevious = joined.filter((r) => metrics.every((m) => r[m] === null) && metrics.some((m) => r[`${m}_prev`] !== null)).length;
      if (onlyCurrent || onlyPrevious) {
        notes.push(`${onlyCurrent} row(s) appear only in the current period and ${onlyPrevious} only in the comparison period.`);
      }
      if (limited.truncated) notes.push(`Showing ${limited.rows.length} of ${limited.total} rows.`);
      const apiCalls = ctx.client.requestCount - before;
      const splits = curStats.splits + prevStats.splits;
      const text = [
        `${limited.total} row(s) for ${scope.organization}: ${current.start} to ${current.end} vs ${previous.start} to ${previous.end}. ${apiCalls} API call(s)${splits ? `, ${splits} split(s)` : ""}, ${Date.now() - started} ms.`,
        ...notes,
        markdownTable(limited.rows, inferColumns(limited.rows, joinedColumns(dimensions, metrics))),
      ].join("\n\n");
      return textResult(text, {
        organization: scope.organization,
        current,
        previous,
        dimensions,
        metrics,
        rowCount: limited.total,
        truncated: limited.truncated,
        rows: limited.rows,
        apiCalls,
        notes,
      });
    }),
  );
}
