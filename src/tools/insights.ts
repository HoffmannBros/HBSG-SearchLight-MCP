import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fsp from "node:fs/promises";
import { z } from "zod";
import { fetchInsightsChunked } from "../chunking.js";
import type { AppContext } from "../context.js";
import { resolveOrganization } from "../context.js";
import { RowSpool, sanitizeFilename, uniquePath } from "../csv.js";
import { DateError, daysInclusive } from "../dates.js";
import { INSIGHT_SECTIONS } from "../fields.js";
import { INSIGHT_ROW_COLUMNS, flattenInsights, type InsightDocument } from "../flatten.js";
import { formatBytes, limitRows, markdownTable, textResult } from "../format.js";
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

const insightsInput = {
  organization: organizationArg,
  account: accountArg,
  accounts: accountsArg,
  start: z.string().optional().describe("Publication start date, YYYY-MM-DD. Give both start and end, or neither (neither returns the latest insight per account)."),
  end: z.string().optional().describe("Publication end date, YYYY-MM-DD."),
  fields: z
    .array(z.string().min(1))
    .optional()
    .describe(`Document sections to return; omit for the whole document. Known sections: ${INSIGHT_SECTIONS.join(", ")}.`),
};

interface InsightsArgs {
  organization?: string | undefined;
  account?: string | undefined;
  accounts?: string[] | undefined;
  start?: string | undefined;
  end?: string | undefined;
  fields?: string[] | undefined;
}

function validateDates(args: InsightsArgs): void {
  if ((args.start === undefined) !== (args.end === undefined)) {
    throw new DateError("Give both start and end, or neither.");
  }
  if (args.start !== undefined && args.end !== undefined) daysInclusive(args.start, args.end);
}

function summarize(doc: InsightDocument): string {
  const insight = doc.insight ?? {};
  const actions = Array.isArray(insight.action_items) ? insight.action_items.length : 0;
  const deep = Array.isArray(insight.deep_insights) ? insight.deep_insights.length : 0;
  return `${doc.account ?? "?"} (${doc.date ?? "?"}, ${String(insight.period ?? "")}): ${actions} action item(s), ${deep} deep insight(s)`;
}

export function registerInsightTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_get_insights",
    {
      title: "Get SearchLight insights",
      description:
        "AI-generated performance insight documents SearchLight has published for your accounts: action items with impact estimates, deep insights, surprise insights, and themes. Without dates you get the most recent document per account. Dates refer to publication, not the analyzed period. Returns documents inline, capped by max_documents.",
      inputSchema: {
        ...insightsInput,
        max_documents: z.number().int().min(1).max(200).default(20).describe("Maximum documents to return inline. Default 20."),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      validateDates(args);
      const before = ctx.client.requestCount;
      const org = await resolveOrganization(ctx, args.organization);
      const docs: InsightDocument[] = [];
      await fetchInsightsChunked<InsightDocument>(
        ctx.client,
        { organization: org, accounts: pickAccounts(args.account, args.accounts), start: args.start, end: args.end, fields: args.fields },
        async (chunk) => {
          docs.push(...chunk);
        },
      );
      docs.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || String(a.account ?? "").localeCompare(String(b.account ?? "")));
      const limited = limitRows(docs, args.max_documents);
      const text = [
        `${limited.total} insight document(s) for ${org}${limited.truncated ? `, showing ${limited.rows.length}` : ""}. ${ctx.client.requestCount - before} API call(s).`,
        limited.rows.map(summarize).join("\n"),
        "```json",
        JSON.stringify(limited.rows, null, 2),
        "```",
      ].join("\n\n");
      return textResult(text, { organization: org, documentCount: limited.total, truncated: limited.truncated, documents: limited.rows });
    }),
  );

  server.registerTool(
    "searchlight_export_insights_csv",
    {
      title: "Export SearchLight insights to CSV",
      description:
        "Fetch insight documents and write them to a file. mode=flat (default) writes one CSV row per action item, deep insight, surprise insight, or theme with the document metadata repeated; mode=json writes the raw documents as a JSON array.",
      inputSchema: {
        ...insightsInput,
        mode: z.enum(["flat", "json"]).default("flat").describe("flat: one row per item (CSV/JSONL). json: raw documents as JSON."),
        filename: filenameArg,
        output_dir: outputDirArg,
        format: formatArg,
        excel_bom: bomArg,
      },
      outputSchema: {
        path: z.string(),
        documents: z.number(),
        rows: z.number(),
        columns: z.array(z.string()),
        bytes: z.number(),
        organization: z.string(),
        mode: z.string(),
        apiCalls: z.number(),
        elapsedMs: z.number(),
      },
      annotations: READ_ONLY,
    },
    guarded(async (args) => {
      validateDates(args);
      const before = ctx.client.requestCount;
      const started = Date.now();
      const org = await resolveOrganization(ctx, args.organization);
      const dir = resolveOutputDir(ctx, args.output_dir);
      const stem = sanitizeFilename(
        args.filename?.trim() || `insights_${sanitizeFilename(org)}_${args.start && args.end ? `${args.start}_${args.end}` : "latest"}`,
      );
      const query = { organization: org, accounts: pickAccounts(args.account, args.accounts), start: args.start, end: args.end, fields: args.fields };
      const apiCallsUsed = () => ctx.client.requestCount - before;

      if (args.mode === "json") {
        const docs: InsightDocument[] = [];
        await fetchInsightsChunked<InsightDocument>(ctx.client, query, async (chunk) => {
          docs.push(...chunk);
        });
        await fsp.mkdir(dir, { recursive: true });
        const target = await uniquePath(dir, withExtension(stem, "json"));
        const body = JSON.stringify(docs, null, 2);
        await fsp.writeFile(target, body, "utf8");
        const bytes = Buffer.byteLength(body);
        return textResult(`Wrote ${docs.length} document(s) to ${target} (${formatBytes(bytes)}). ${apiCallsUsed()} API call(s).`, {
          path: target,
          documents: docs.length,
          rows: docs.length,
          columns: [],
          bytes,
          organization: org,
          mode: "json",
          apiCalls: apiCallsUsed(),
          elapsedMs: Date.now() - started,
        });
      }

      const spool = await RowSpool.create({ dir, initialColumns: [...INSIGHT_ROW_COLUMNS] });
      let documents = 0;
      const preview: Record<string, unknown>[] = [];
      try {
        await fetchInsightsChunked<InsightDocument>(ctx.client, query, async (chunk) => {
          documents += chunk.length;
          const rows = flattenInsights(chunk);
          for (const row of rows) if (preview.length < 5) preview.push(row);
          await spool.pushMany(rows);
        });
      } catch (err) {
        await spool.discard();
        throw err;
      }
      const result = await spool.finalize(withExtension(stem, args.format), { format: args.format, bom: args.excel_bom });
      const text = [
        `Wrote ${result.rows} row(s) from ${documents} document(s) to ${result.path} (${formatBytes(result.bytes)}). ${apiCallsUsed()} API call(s), ${Date.now() - started} ms.`,
        preview.length > 0 ? `Preview:\n${markdownTable(preview, ["account", "date", "section", "title", "priority", "impact_display"])}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, {
        path: result.path,
        documents,
        rows: result.rows,
        columns: result.columns,
        bytes: result.bytes,
        organization: org,
        mode: "flat",
        apiCalls: apiCallsUsed(),
        elapsedMs: Date.now() - started,
      });
    }),
  );
}
