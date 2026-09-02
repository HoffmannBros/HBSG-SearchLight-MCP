import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchEventsChunked, type EventsQuery } from "../chunking.js";
import type { AppContext } from "../context.js";
import { resolveOrganization } from "../context.js";
import { RowSpool, sanitizeFilename, type Row } from "../csv.js";
import { DateError, MAX_INTERVAL_DAYS, daysInclusive, type Interval } from "../dates.js";
import { filtersToParams, type Filters } from "../filters.js";
import { formatBytes, inferColumns, limitRows, markdownTable, textResult } from "../format.js";
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
  withExtension,
} from "./common.js";

const eventsInput = {
  organization: organizationArg,
  fields: fieldsArg,
  start: dateArg("Start"),
  end: dateArg("End"),
  interval: intervalArg,
  account: accountArg,
  accounts: accountsArg,
  filters: filtersArg,
  filter: crossFilterArg,
};

interface EventsArgs {
  organization?: string | undefined;
  fields: string[];
  start: string;
  end: string;
  interval?: Interval | undefined;
  account?: string | undefined;
  accounts?: string[] | undefined;
  filters?: Record<string, unknown> | undefined;
  filter?: unknown[] | undefined;
}

interface Prepared {
  query: EventsQuery;
  columns: string[];
  notes: string[];
  days: number;
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
  const organization = await resolveOrganization(ctx, args.organization);
  const query: EventsQuery = {
    organization,
    fields: args.fields,
    start: args.start,
    end: args.end,
    interval,
    accounts: pickAccounts(args.account, args.accounts),
    extraParams,
  };
  const columns = [...(interval === "total" ? [] : ["start", "end"]), ...args.fields];
  return { query, columns, notes, days };
}

export function registerEventsTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_query_events",
    {
      title: "Query SearchLight events",
      description:
        "Aggregate metrics over a date range, broken out by the dimensions in fields, returned inline. One row per unique combination of dimension values (a single row when only metrics are requested). Supports filters on any field. Ranges over 90 days need an interval (month, week, day). Large requests are split automatically. For big result sets use searchlight_export_events_csv instead; inline output is capped by max_rows.",
      inputSchema: {
        ...eventsInput,
        max_rows: z.number().int().min(1).max(2000).default(200).describe("Maximum rows to return inline. Default 200, max 2000."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const { query, columns, notes } = await prepare(ctx, args);
      const rows: Row[] = [];
      const stats = await fetchEventsChunked(ctx.client, query, async (chunk) => {
        rows.push(...chunk);
      });
      const limited = limitRows(rows, args.max_rows);
      const apiCalls = ctx.client.requestCount - before;
      if (limited.truncated) {
        notes.push(`Showing ${limited.rows.length} of ${limited.total} rows. Use searchlight_export_events_csv for the full set.`);
      }
      const text = [
        `${limited.total} row(s) for ${query.organization}, ${query.start} to ${query.end}, interval=${query.interval}${query.accounts ? `, accounts=${query.accounts.join(",")}` : ""}. ${apiCalls} API call(s)${stats.splits ? `, ${stats.splits} split(s)` : ""}, ${Date.now() - started} ms.`,
        ...notes,
        markdownTable(limited.rows, inferColumns(limited.rows, columns)),
      ].join("\n\n");
      return textResult(text, {
        organization: query.organization,
        start: query.start,
        end: query.end,
        interval: query.interval,
        accounts: query.accounts,
        rowCount: limited.total,
        truncated: limited.truncated,
        rows: limited.rows,
        apiCalls,
        chunks: stats.chunks,
        splits: stats.splits,
        notes,
      });
    }),
  );

  server.registerTool(
    "searchlight_export_events_csv",
    {
      title: "Export SearchLight events to CSV",
      description:
        "Run an events query of any size and write the rows to a CSV (or JSONL) file in the export folder. Splits the request by account and date window automatically when SearchLight rejects it as too large, so multi-year, multi-account pulls work. Ranges over 90 days default to interval=month. Returns the file path, row count, columns, and a short preview.",
      inputSchema: {
        ...eventsInput,
        filename: filenameArg,
        output_dir: outputDirArg,
        format: formatArg,
        excel_bom: bomArg,
        preview_rows: previewRowsArg,
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
        apiCalls: z.number(),
        chunks: z.number(),
        splits: z.number(),
        elapsedMs: z.number(),
        preview: z.array(z.record(z.string(), z.unknown())),
        notes: z.array(z.string()),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      const before = ctx.client.requestCount;
      const started = Date.now();
      const { query, columns, notes } = await prepare(ctx, args);
      const dir = resolveOutputDir(ctx, args.output_dir);
      const spool = await RowSpool.create({ dir, initialColumns: columns });
      const preview: Row[] = [];
      let stats;
      try {
        stats = await fetchEventsChunked(ctx.client, query, async (chunk) => {
          for (const row of chunk) {
            if (preview.length < args.preview_rows) preview.push(row);
          }
          await spool.pushMany(chunk);
        });
      } catch (err) {
        await spool.discard();
        throw err;
      }
      const baseName =
        args.filename?.trim() ||
        `events_${sanitizeFilename(query.organization)}_${query.start}_${query.end}_${query.interval}`;
      const result = await spool.finalize(withExtension(sanitizeFilename(baseName), args.format), {
        format: args.format,
        bom: args.excel_bom,
      });
      const apiCalls = ctx.client.requestCount - before;
      const elapsedMs = Date.now() - started;
      if (stats.splits > 0) {
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
        apiCalls,
        chunks: stats.chunks,
        splits: stats.splits,
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
