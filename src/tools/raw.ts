import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fsp from "node:fs/promises";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { sanitizeFilename, uniquePath } from "../csv.js";
import { formatBytes, limitRows, textResult } from "../format.js";
import { READ_ONLY, guarded, outputDirArg, resolveOutputDir, withExtension } from "./common.js";

export function registerRawTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_api_call",
    {
      title: "Call the SearchLight API directly",
      description:
        "Escape hatch for anything the typed tools do not cover, including endpoints or parameters added to the beta API later. GET only, and it does none of the chunking the typed tools do, so prefer searchlight_query_events or searchlight_export_events_csv for events. Give the path (e.g. /api, /api/<organization>/events) and query parameters exactly as the docs describe; filter expressions must be passed as JSON strings. On /events, a start-to-end span over 90 days needs interval=month, week, or day; without one the request is refused locally rather than spending an API call. Array responses are capped inline by max_items; set save_as to write the full response to a JSON file.",
      inputSchema: {
        path: z.string().regex(/^\/api(\/|$)/).describe("Request path starting with /api."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query parameters. On /events these are fields, start, end, interval, account/accounts, and filters; spans over 90 days require interval."),
        max_items: z.number().int().min(1).max(5000).default(200).describe("Maximum array items to return inline. Default 200."),
        save_as: z.string().optional().describe("File name to save the full JSON response into the export folder."),
        output_dir: outputDirArg,
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ path, params, max_items, save_as, output_dir }) => {
      const before = ctx.client.requestCount;
      const data = await ctx.client.get<unknown>(path, params ?? {});
      const apiCalls = ctx.client.requestCount - before;
      let savedPath: string | undefined;
      let savedBytes = 0;
      if (save_as) {
        const dir = resolveOutputDir(ctx, output_dir);
        await fsp.mkdir(dir, { recursive: true });
        savedPath = await uniquePath(dir, withExtension(sanitizeFilename(save_as), "json"));
        const body = JSON.stringify(data, null, 2);
        await fsp.writeFile(savedPath, body, "utf8");
        savedBytes = Buffer.byteLength(body);
      }
      if (Array.isArray(data)) {
        const limited = limitRows(data, max_items);
        const text = [
          `${limited.total} item(s) from ${path}${limited.truncated ? `, showing ${limited.rows.length}` : ""}. ${apiCalls} API call(s).`,
          savedPath ? `Saved full response to ${savedPath} (${formatBytes(savedBytes)}).` : "",
          "```json",
          JSON.stringify(limited.rows, null, 2),
          "```",
        ]
          .filter(Boolean)
          .join("\n\n");
        return textResult(text, { path, itemCount: limited.total, truncated: limited.truncated, items: limited.rows, savedPath, apiCalls });
      }
      const text = [
        `Response from ${path}. ${apiCalls} API call(s).`,
        savedPath ? `Saved full response to ${savedPath} (${formatBytes(savedBytes)}).` : "",
        "```json",
        JSON.stringify(data, null, 2),
        "```",
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, { path, data, savedPath, apiCalls });
    }),
  );
}
