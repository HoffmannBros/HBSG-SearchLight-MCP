import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SearchLightApiError } from "../client.js";
import type { AppContext } from "../context.js";
import { resolveOrganization } from "../context.js";
import { RowSpool, sanitizeFilename, type Row } from "../csv.js";
import { DateError, monthRange } from "../dates.js";
import { BENCHMARK_DIMENSIONS, BENCHMARK_METRICS } from "../fields.js";
import { FilterError, filtersToParams, type Filters } from "../filters.js";
import { formatBytes, inferColumns, markdownTable, textResult } from "../format.js";
import {
  READ_ONLY,
  accountArg,
  accountsArg,
  bomArg,
  filenameArg,
  formatArg,
  guarded,
  organizationArg,
  outputDirArg,
  pickAccounts,
  resolveOutputDir,
  withExtension,
} from "./common.js";

const MONTH = /^\d{4}-\d{2}$/;
const monthArg = z
  .string()
  .regex(/^(\d{4}-\d{2}|previous-mtd)$/)
  .describe("Calendar month as YYYY-MM, or previous-mtd for the prior month through the same elapsed days as the current month-to-date. Future months are rejected.");

const benchmarkFieldsArg = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    `Benchmark metrics and optional dimensions, in output order. Metrics: ${BENCHMARK_METRICS.join(", ")}. Dimensions: ${BENCHMARK_DIMENSIONS.join(", ")}.`,
  );

const benchmarkFiltersArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(`Filters on the benchmark dimensions only (${BENCHMARK_DIMENSIONS.join(", ")}), e.g. {"normalizedBusinessUnit":"HVAC"}.`);

function benchmarkParams(fields: string[], filters: Record<string, unknown> | undefined, accounts: string[] | undefined) {
  const allowed: readonly string[] = BENCHMARK_DIMENSIONS;
  for (const key of Object.keys(filters ?? {})) {
    if (!allowed.includes(key)) {
      throw new FilterError(`Benchmarks can only be filtered by ${allowed.join(", ")}; "${key}" is not supported.`);
    }
  }
  return {
    ...filtersToParams(filters as Filters | undefined),
    fields: fields.join(","),
    account: accounts && accounts.length === 1 ? accounts[0] : undefined,
    accounts: accounts && accounts.length > 1 ? accounts.join(",") : undefined,
  };
}

const BASE_COLUMNS = ["month", "series", "cohortAccounts"];

export function registerBenchmarkTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_get_benchmarks",
    {
      title: "Get SearchLight benchmarks",
      description:
        "Anonymized industry benchmarks for one calendar month: the industry figure for each metric plus the p10/p25/p50/p75/p90 distribution across the cohort. Compare your own numbers from searchlight_query_events against these. One month per call; use searchlight_export_benchmarks_csv for several months.",
      inputSchema: {
        organization: organizationArg,
        fields: benchmarkFieldsArg,
        month: monthArg,
        account: accountArg,
        accounts: accountsArg,
        filters: benchmarkFiltersArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ organization, fields, month, account, accounts, filters }) => {
      const org = await resolveOrganization(ctx, organization);
      const params = benchmarkParams(fields, filters, pickAccounts(account, accounts));
      const rows = await ctx.client.get<Row[]>(`/api/${encodeURIComponent(org)}/benchmarks`, { ...params, month });
      const columns = inferColumns(rows, ["series", "cohortAccounts", ...fields]);
      return textResult(`${rows.length} row(s) for ${org}, month=${month}.\n\n${markdownTable(rows, columns)}`, {
        organization: org,
        month,
        rowCount: rows.length,
        rows,
      });
    }),
  );

  server.registerTool(
    "searchlight_export_benchmarks_csv",
    {
      title: "Export SearchLight benchmarks to CSV",
      description:
        "Fetch benchmarks for several months (a list, or a start_month..end_month range) and write one CSV with a month column. Months whose benchmark data is still being gathered are skipped and reported.",
      inputSchema: {
        organization: organizationArg,
        fields: benchmarkFieldsArg,
        months: z.array(monthArg).optional().describe("Explicit months, e.g. [\"2026-04\",\"2026-05\",\"previous-mtd\"]."),
        start_month: z.string().regex(MONTH).optional().describe("First month of a range, YYYY-MM. Use with end_month."),
        end_month: z.string().regex(MONTH).optional().describe("Last month of a range, YYYY-MM. Use with start_month."),
        account: accountArg,
        accounts: accountsArg,
        filters: benchmarkFiltersArg,
        filename: filenameArg,
        output_dir: outputDirArg,
        format: formatArg,
        excel_bom: bomArg,
      },
      outputSchema: {
        path: z.string(),
        rows: z.number(),
        columns: z.array(z.string()),
        bytes: z.number(),
        organization: z.string(),
        months: z.array(z.string()),
        skippedMonths: z.array(z.object({ month: z.string(), reason: z.string() })),
        apiCalls: z.number(),
        elapsedMs: z.number(),
        notes: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const months = [...(args.months ?? [])];
      if (args.start_month || args.end_month) {
        if (!args.start_month || !args.end_month) throw new DateError("start_month and end_month must be given together.");
        months.push(...monthRange(args.start_month, args.end_month));
      }
      const unique = [...new Set(months)];
      if (unique.length === 0) throw new DateError("Give months, or start_month and end_month.");
      const org = await resolveOrganization(ctx, args.organization);
      const params = benchmarkParams(args.fields, args.filters, pickAccounts(args.account, args.accounts));
      const path = `/api/${encodeURIComponent(org)}/benchmarks`;
      const skipped: Array<{ month: string; reason: string }> = [];
      const results = await Promise.all(
        unique.map(async (month) => {
          try {
            const rows = await ctx.client.get<Row[]>(path, { ...params, month });
            return rows.map((r) => ({ month, ...r }));
          } catch (err) {
            if (err instanceof SearchLightApiError && err.status === 503) {
              skipped.push({ month, reason: err.apiMessage });
              return [];
            }
            throw err;
          }
        }),
      );
      const dir = resolveOutputDir(ctx, args.output_dir);
      const spool = await RowSpool.create({ dir, initialColumns: [...BASE_COLUMNS, ...args.fields] });
      try {
        for (const rows of results) await spool.pushMany(rows);
      } catch (err) {
        await spool.discard();
        throw err;
      }
      const baseName =
        args.filename?.trim() || `benchmarks_${sanitizeFilename(org)}_${unique[0]}_${unique[unique.length - 1]}`;
      const result = await spool.finalize(withExtension(sanitizeFilename(baseName), args.format), {
        format: args.format,
        bom: args.excel_bom,
      });
      const notes = skipped.map((s) => `Skipped ${s.month}: ${s.reason}`);
      const apiCalls = ctx.client.requestCount - before;
      const elapsedMs = Date.now() - started;
      const text = [
        `Wrote ${result.rows} row(s) for ${unique.length} month(s) to ${result.path} (${formatBytes(result.bytes)}). ${apiCalls} API call(s), ${elapsedMs} ms.`,
        `Columns: ${result.columns.join(", ")}`,
        ...notes,
      ].join("\n\n");
      return textResult(text, {
        path: result.path,
        rows: result.rows,
        columns: result.columns,
        bytes: result.bytes,
        organization: org,
        months: unique,
        skippedMonths: skipped,
        apiCalls,
        elapsedMs,
        notes,
      });
    }),
  );
}
