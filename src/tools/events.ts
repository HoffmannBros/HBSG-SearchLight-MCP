import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fetchEventsChunked, type ChunkStats, type EventsQuery } from "../chunking.js";
import { classifyFields } from "../compare.js";
import type { AppContext } from "../context.js";
import { resolveScope } from "../context.js";
import { RowSpool, sanitizeFilename, type Row } from "../csv.js";
import { DateError, MAX_INTERVAL_DAYS, daysInclusive, type Interval } from "../dates.js";
import { filtersToParams, type Filters } from "../filters.js";
import { formatBytes, inferColumns, limitRows, markdownTable, textResult } from "../format.js";
import {
  MAX_OR_EXPANSION,
  RowGuard,
  allMetricsZero,
  equalityParam,
  filterFieldNames,
  gradingNote,
  orFallbackNote,
  orTooManyNote,
  qualifyingOrFilters,
  reconcileSpend,
  recordGrainNotes,
  regexOrNotEmptyNote,
  regexOrNotFilterFields,
  spendReconciliationFields,
  spendReconciliationNote,
  summingNote,
  unattributedSpendRows,
  zeroTotalCheckApplies,
  zeroTotalConfirmedNote,
  zeroTotalFailedMessage,
  type OrFilter,
  type SpendReconciliation,
} from "../guards.js";
import {
  READ_ONLY,
  accountArg,
  accountsArg,
  bomArg,
  crossFilterArg,
  dateArg,
  fieldsArg,
  filenameArg,
  filtersArg,
  formatArg,
  guarded,
  intervalArg,
  organizationArg,
  outputDirArg,
  pickAccounts,
  previewRowsArg,
  resolveOutputDir,
  subsetArg,
  withExtension,
} from "./common.js";

const eventsInput = {
  organization: organizationArg,
  subset: subsetArg,
  fields: fieldsArg,
  start: dateArg("Start"),
  end: dateArg("End"),
  interval: intervalArg,
  account: accountArg,
  accounts: accountsArg,
  filters: filtersArg,
  filter: crossFilterArg,
  reconcile_spend: z
    .boolean()
    .default(true)
    .describe(
      "When spend is split by a dimension other than time or account with interval=total, send 1 extra request for unsplit spend and report any spend on combinations with no tracked events, which SearchLight leaves out of the split. Default true; false skips the extra request.",
    ),
  drop_placeholder_rows: z
    .boolean()
    .default(true)
    .describe("Drop rows where every requested dimension is blank or N/A and every metric is 0. Never drops a row with a non-zero metric. Default true."),
  retry_or_filters: z
    .boolean()
    .default(true)
    .describe(
      `When the result is empty and a filters value is ["or", v1, v2, ...] of plain values, re-send once per value with an equality filter and combine the rows (SearchLight sometimes answers an or filter with no rows). Up to ${MAX_OR_EXPANSION} values; the field is added to fields when missing. Default true; false never retries.`,
    ),
  check_zero_total: z
    .boolean()
    .default(true)
    .describe(
      "When interval=total over more than 31 days with no dimensions reads 0 for every metric, send 1 extra request by month to tell a failed total read from a real zero. Default true; false skips it.",
    ),
};

interface EventsArgs {
  organization?: string | undefined;
  subset?: string | undefined;
  fields: string[];
  start: string;
  end: string;
  interval?: Interval | undefined;
  account?: string | undefined;
  accounts?: string[] | undefined;
  filters?: Record<string, unknown> | undefined;
  filter?: unknown[] | undefined;
  reconcile_spend: boolean;
  drop_placeholder_rows: boolean;
  retry_or_filters: boolean;
  check_zero_total: boolean;
}

interface Prepared {
  query: EventsQuery;
  columns: string[];
  notes: string[];
  days: number;
  dimensions: string[];
  metrics: string[];
  guard: RowGuard;
  /** Fields for the unsplit-spend request, or null when no reconciliation applies. */
  reconcileFields: string[] | null;
  /** Qualifying `or` filters, in the caller's order; the first is expanded on an empty result. */
  orFilters: OrFilter[];
  /** Per-field filters that use regex or not. */
  regexOrNot: string[];
  retryOr: boolean;
  checkZeroTotal: boolean;
}

async function prepare(ctx: AppContext, args: EventsArgs): Promise<Prepared> {
  const days = daysInclusive(args.start, args.end);
  const notes: string[] = [];
  let interval: Interval = args.interval ?? "total";
  if (args.interval === undefined && days > MAX_INTERVAL_DAYS) {
    interval = "month";
    notes.push(`Range is ${days} days, over the ${MAX_INTERVAL_DAYS}-day limit for a single total, so interval=month was used; rows are tagged with start and end.`);
  }
  if (interval === "total" && days > MAX_INTERVAL_DAYS) {
    throw new DateError(
      `The range is ${days} days but interval=total is limited to ${MAX_INTERVAL_DAYS} days by SearchLight's attribution window. Use interval=month, week, or day, or shorten the range.`,
    );
  }
  const extraParams = filtersToParams(args.filters as Filters | undefined, args.filter);
  const scope = await resolveScope(ctx, args.organization, pickAccounts(args.account, args.accounts), args.subset);
  notes.push(...scope.notes);
  const query: EventsQuery = {
    organization: scope.organization,
    fields: args.fields,
    start: args.start,
    end: args.end,
    interval,
    accounts: scope.accounts,
    subset: scope.subset,
    extraParams,
  };
  const columns = [...(interval === "total" ? [] : ["start", "end"]), ...args.fields];
  // The bundled field reference (no drift from the live dictionary at the
  // 2026-11-11 probe). Asking the client for the live one would send /api a
  // second time whenever the first attempt failed.
  const { dimensions, metrics } = classifyFields(args.fields, undefined);
  const guard = new RowGuard({
    dimensions,
    metrics,
    interval,
    start: args.start,
    end: args.end,
    dropPlaceholders: args.drop_placeholder_rows,
    filterFields: filterFieldNames(args.filters, args.filter),
  });
  const reconcileFields = args.reconcile_spend ? spendReconciliationFields(dimensions, metrics, interval) : null;
  return {
    query,
    columns,
    notes,
    days,
    dimensions,
    metrics,
    guard,
    reconcileFields,
    orFilters: qualifyingOrFilters(args.filters),
    regexOrNot: regexOrNotFilterFields(args.filters),
    retryOr: args.retry_or_filters,
    checkZeroTotal: args.check_zero_total,
  };
}

interface Fetched {
  stats: ChunkStats;
  reconciliation: SpendReconciliation | undefined;
  /** Notes from the automatic repairs (or-filter fallback, zero-total check). */
  repairNotes: string[];
  /** Set when a long-range total read 0 but the monthly rows did not. */
  zeroTotalFailure?: { message: string; monthly: Row[] } | undefined;
}

function mergeStats(into: ChunkStats, from: ChunkStats): void {
  into.chunks += from.chunks;
  into.splits += from.splits;
  for (const n of from.notes ?? []) {
    if (!(into.notes ?? []).includes(n)) into.notes = [...(into.notes ?? []), n];
  }
}

/**
 * Run the events query through the row guard, and the unsplit-spend request
 * beside it when one applies: same organization, subset, accounts, filters and
 * range, with fields reduced to the account dimensions plus spend. `onRows`
 * gets the rows the guard keeps. Then the automatic repairs, each of which
 * sends extra requests and says so in `repairNotes`:
 * - K2: an empty result with an `or` filter of plain values is re-sent once
 *   per value with an equality filter (the field added to fields if missing);
 * - K9: a long-range total with no dimensions that reads all zero is checked
 *   once by month.
 */
async function fetchGuarded(ctx: AppContext, p: Prepared, onRows: (rows: Row[]) => Promise<void>): Promise<Fetched> {
  const accountFields = (p.reconcileFields ?? []).filter((f) => f !== "spend");
  const spendRows: Row[] = [];
  const unsplit: Row[] = [];
  let received = 0;
  let allZero = true;
  const [stats, recStats] = await Promise.all([
    fetchEventsChunked(ctx.client, p.query, async (chunk) => {
      received += chunk.length;
      if (!allMetricsZero(chunk, p.metrics)) allZero = false;
      const kept = p.guard.accept(chunk);
      if (p.reconcileFields) {
        for (const r of kept) spendRows.push({ ...Object.fromEntries(accountFields.map((f) => [f, r[f]])), spend: r.spend });
      }
      await onRows(kept);
    }),
    p.reconcileFields
      ? fetchEventsChunked(ctx.client, { ...p.query, fields: p.reconcileFields }, async (chunk) => {
          unsplit.push(...chunk);
        })
      : Promise.resolve(undefined),
  ]);
  if (recStats?.notes) stats.notes = [...(stats.notes ?? []), ...recStats.notes];
  let reconciliation = p.reconcileFields ? reconcileSpend(spendRows, unsplit, accountFields) : undefined;
  const repairNotes: string[] = [];

  // K2: or-filter fallback, only on an empty result.
  let retried = false;
  const [filter, ...rest] = p.orFilters;
  if (received === 0 && filter) {
    if (!p.retryOr) {
      repairNotes.push(
        `No rows, and the ${filter.field} filter is ["or", ...], which SearchLight sometimes answers with an empty result where single values return rows. Not retried because retry_or_filters=false; try one value per call.`,
      );
    } else if (filter.values.length > MAX_OR_EXPANSION) {
      repairNotes.push(orTooManyNote(filter));
    } else {
      retried = true;
      const addedField = !p.query.fields.includes(filter.field);
      const fields = addedField ? [filter.field, ...p.query.fields] : p.query.fields;
      if (addedField) p.columns.splice(p.query.interval === "total" ? 0 : 2, 0, filter.field);
      const rowsPerValue = filter.values.map(() => 0);
      const results = await Promise.all(
        filter.values.map((value, i) =>
          fetchEventsChunked(
            ctx.client,
            { ...p.query, fields, extraParams: { ...(p.query.extraParams ?? {}), [filter.field]: equalityParam(value) } },
            async (chunk) => {
              rowsPerValue[i] = (rowsPerValue[i] ?? 0) + chunk.length;
              await onRows(p.guard.accept(chunk));
            },
          ),
        ),
      );
      for (const r of results) mergeStats(stats, r);
      repairNotes.push(orFallbackNote({ filter, addedField, rowsPerValue, otherFields: rest.map((f) => f.field) }));
      if (reconciliation) {
        reconciliation = undefined;
        repairNotes.push("The spend check was not repeated for the per-value retries, so spendReconciliation is left out.");
      }
    }
  } else if (received === 0 && p.regexOrNot.length > 0) {
    repairNotes.push(regexOrNotEmptyNote(p.regexOrNot));
  }

  // K9: zero-total cross-check.
  let zeroTotalFailure: Fetched["zeroTotalFailure"];
  if (!retried && p.checkZeroTotal && allZero && zeroTotalCheckApplies(p.query.interval, p.dimensions, p.days)) {
    const monthly: Row[] = [];
    const monthStats = await fetchEventsChunked(ctx.client, { ...p.query, interval: "month" }, async (chunk) => {
      monthly.push(...chunk);
    });
    mergeStats(stats, { ...monthStats, chunks: 0, splits: 0 });
    if (allMetricsZero(monthly, p.metrics)) {
      repairNotes.push(zeroTotalConfirmedNote(p.days));
    } else {
      zeroTotalFailure = { message: zeroTotalFailedMessage(p.metrics, p.days, monthly), monthly };
    }
  }
  return { stats, reconciliation, repairNotes, zeroTotalFailure };
}

/** Notes about the result, in reading order, after the scope and range notes. */
function resultNotes(p: Prepared, f: Fetched): string[] {
  const summing = summingNote(p.metrics, p.query.interval);
  const grading = gradingNote(p.metrics);
  return [
    ...(f.stats.notes ?? []),
    ...(grading ? [grading] : []),
    ...f.repairNotes,
    ...(summing ? [summing] : []),
    ...recordGrainNotes(p.dimensions, p.metrics),
    ...p.guard.notes(),
    ...(f.reconciliation ? [spendReconciliationNote(f.reconciliation)] : []),
  ];
}

/** The error result for a failed long-range total: the message, the monthly rows, and every note. */
function zeroTotalErrorResult(p: Prepared, f: Fetched, apiCalls: number): CallToolResult {
  const failure = f.zeroTotalFailure!;
  const notes = [...p.notes, ...resultNotes(p, f)];
  const table = markdownTable(failure.monthly, inferColumns(failure.monthly, ["start", "end", ...p.query.fields]));
  return {
    isError: true,
    content: [{ type: "text", text: [failure.message, `${apiCalls} API call(s).`, ...notes, table].join("\n\n") }],
    structuredContent: {
      error: "zero-total-read-failed",
      organization: p.query.organization,
      start: p.query.start,
      end: p.query.end,
      interval: p.query.interval,
      monthlyRows: failure.monthly,
      apiCalls,
      notes,
    },
  };
}

const reconciliationSchema = z
  .object({
    total: z.number(),
    inRows: z.number(),
    missing: z.number(),
    byAccount: z
      .array(
        z.object({
          accountKey: z.unknown().optional(),
          account: z.unknown().optional(),
          total: z.number(),
          inRows: z.number(),
          missing: z.number(),
        }),
      )
      .optional(),
  })
  .optional();

export function registerEventsTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_query_events",
    {
      title: "Query SearchLight events",
      description:
        "Aggregate metrics over a date range, broken out by the dimensions in fields, returned inline. One row per unique combination of dimension values (a single row when only metrics are requested). Supports filters on any field. Ranges over 90 days need an interval (month, week, day). Large requests are split automatically. Read the notes: they say which metrics must not be summed across rows, and when a split leaves spend out (reported in spendReconciliation). For big result sets use searchlight_export_events_csv instead; inline output is capped by max_rows.",
      inputSchema: {
        ...eventsInput,
        max_rows: z.number().int().min(1).max(2000).default(200).describe("Maximum rows to return inline. Default 200, max 2000."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const prepared = await prepare(ctx, args);
      const { query, columns, notes } = prepared;
      const rows: Row[] = [];
      const fetched = await fetchGuarded(ctx, prepared, async (kept) => {
        rows.push(...kept);
      });
      if (fetched.zeroTotalFailure) return zeroTotalErrorResult(prepared, fetched, ctx.client.requestCount - before);
      const { stats, reconciliation } = fetched;
      notes.push(...resultNotes(prepared, fetched));
      const limited = limitRows(rows, args.max_rows);
      const apiCalls = ctx.client.requestCount - before;
      if (limited.truncated) {
        notes.push(`Showing ${limited.rows.length} of ${limited.total} rows. Use searchlight_export_events_csv for the full set.`);
      }
      const text = [
        `${limited.total} row(s) for ${query.organization}, ${query.start} to ${query.end}, interval=${query.interval}${query.subset ? `, subset=${query.subset}` : ""}${query.accounts ? `, accounts=${query.accounts.join(",")}` : ""}. ${apiCalls} API call(s)${stats.splits ? `, ${stats.splits} split(s)` : ""}, ${Date.now() - started} ms.`,
        ...notes,
        markdownTable(limited.rows, inferColumns(limited.rows, columns)),
      ].join("\n\n");
      return textResult(text, {
        organization: query.organization,
        start: query.start,
        end: query.end,
        interval: query.interval,
        accounts: query.accounts,
        subset: query.subset,
        rowCount: limited.total,
        truncated: limited.truncated,
        rows: limited.rows,
        apiCalls,
        chunks: stats.chunks,
        splits: stats.splits,
        ...(reconciliation ? { spendReconciliation: reconciliation } : {}),
        notes,
      });
    }),
  );

  server.registerTool(
    "searchlight_export_events_csv",
    {
      title: "Export SearchLight events to CSV",
      description:
        "Run an events query of any size and write the rows to a CSV (or JSONL) file in the export folder. Splits the request by account and date window automatically when SearchLight rejects it as too large, so multi-year, multi-account pulls work. Ranges over 90 days default to interval=month. Returns the file path, row count, columns, a short preview, notes on how to read the rows, and spendReconciliation when a split leaves spend out.",
      inputSchema: {
        ...eventsInput,
        filename: filenameArg,
        output_dir: outputDirArg,
        format: formatArg,
        excel_bom: bomArg,
        preview_rows: previewRowsArg,
        add_unattributed_spend_row: z
          .boolean()
          .default(false)
          .describe(
            'When the spend check finds spend on combinations with no tracked events, append one row per account with the other dimension columns set to "(no tracked events)" and only spend filled, so the file\'s spend adds up to the total. Default false: the file holds only SearchLight\'s rows and the shortfall is reported in the result.',
          ),
      },
      outputSchema: {
        path: z.string(),
        rows: z.number(),
        columns: z.array(z.string()),
        bytes: z.number(),
        format: z.string(),
        organization: z.string(),
        start: z.string(),
        end: z.string(),
        interval: z.string(),
        accounts: z.array(z.string()).optional(),
        subset: z.string().optional(),
        apiCalls: z.number(),
        chunks: z.number(),
        splits: z.number(),
        spendReconciliation: reconciliationSchema,
        elapsedMs: z.number(),
        preview: z.array(z.record(z.string(), z.unknown())),
        notes: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const prepared = await prepare(ctx, args);
      const { query, columns, notes } = prepared;
      const dir = resolveOutputDir(ctx, args.output_dir);
      const spool = await RowSpool.create({ dir, initialColumns: columns });
      const preview: Row[] = [];
      let fetched: Fetched;
      let appended = 0;
      try {
        fetched = await fetchGuarded(ctx, prepared, async (kept) => {
          for (const row of kept) {
            if (preview.length < args.preview_rows) preview.push(row);
          }
          await spool.pushMany(kept);
        });
        if (args.add_unattributed_spend_row && fetched.reconciliation) {
          const extra = unattributedSpendRows(fetched.reconciliation, prepared.dimensions);
          await spool.pushMany(extra);
          appended = extra.length;
        }
      } catch (err) {
        await spool.discard();
        throw err;
      }
      if (fetched.zeroTotalFailure) {
        await spool.discard();
        return zeroTotalErrorResult(prepared, fetched, ctx.client.requestCount - before);
      }
      const { stats, reconciliation } = fetched;
      const baseName =
        args.filename?.trim() ||
        `events_${sanitizeFilename(query.organization)}_${query.start}_${query.end}_${query.interval}`;
      const result = await spool.finalize(withExtension(sanitizeFilename(baseName), args.format), {
        format: args.format,
        bom: args.excel_bom,
      });
      const apiCalls = ctx.client.requestCount - before;
      const elapsedMs = Date.now() - started;
      notes.push(...resultNotes(prepared, fetched));
      if (appended > 0) {
        notes.push(`Appended ${appended} row(s) with "(no tracked events)" in the dimension columns carrying the missing spend, so the file's spend adds up to the total.`);
      } else if (reconciliation && reconciliation.missing > 0) {
        notes.push("The file holds only SearchLight's rows, so its spend is short by the amount above; add_unattributed_spend_row=true appends it as one row per account.");
      }
      if (stats.splits > 0 || stats.notes) {
        notes.push("Rows are written in the order chunks completed; sort by start or account in your spreadsheet if needed.");
      }
      const structured = {
        path: result.path,
        rows: result.rows,
        columns: result.columns,
        bytes: result.bytes,
        format: args.format,
        organization: query.organization,
        start: query.start,
        end: query.end,
        interval: query.interval,
        accounts: query.accounts,
        subset: query.subset,
        apiCalls,
        chunks: stats.chunks,
        splits: stats.splits,
        ...(reconciliation ? { spendReconciliation: reconciliation } : {}),
        elapsedMs,
        preview,
        notes,
      };
      const text = [
        `Wrote ${result.rows} row(s) to ${result.path} (${formatBytes(result.bytes)}). ${apiCalls} API call(s) in ${stats.chunks} chunk(s), ${elapsedMs} ms.`,
        `Columns: ${result.columns.join(", ")}`,
        ...notes,
        preview.length > 0 ? `Preview:\n${markdownTable(preview, result.columns)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, structured);
    }),
  );
}
