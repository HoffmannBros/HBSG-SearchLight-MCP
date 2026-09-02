import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccessInfo, EndpointInfo } from "../client.js";
import type { AppContext } from "../context.js";
import { BENCHMARK_DIMENSIONS, BENCHMARK_METRICS, STATIC_FIELDS, staticField, type FieldInfo } from "../fields.js";
import { describeError, markdownTable, textResult } from "../format.js";
import { READ_ONLY, guarded } from "./common.js";

export interface CatalogField {
  name: string;
  type: "dimension" | "metric" | string;
  displayName?: string | undefined;
  definition: string;
  format?: string | undefined;
  benchmarkable?: boolean | undefined;
  group?: string | undefined;
  values?: string[] | undefined;
  leadGrading?: boolean | undefined;
  endpoints: string[];
}

function endpointsFor(name: string, type: string, endpoints: EndpointInfo[] | undefined): string[] {
  if (endpoints && endpoints.length > 0) {
    return endpoints
      .filter((e) => (e.metrics ?? []).includes(name) || (e.dimensions ?? []).includes(name))
      .map((e) => e.endpoint);
  }
  const out = ["events"];
  const benchmarkNames: readonly string[] = type === "metric" ? BENCHMARK_METRICS : BENCHMARK_DIMENSIONS;
  if (benchmarkNames.includes(name)) out.push("benchmarks");
  return out;
}

/** Merge the live /api dictionary with the bundled reference. */
export function buildCatalog(access: AccessInfo | undefined): CatalogField[] {
  const names = new Set<string>(STATIC_FIELDS.map((f) => f.name));
  const dictionary = access?.dictionary ?? {};
  for (const name of Object.keys(dictionary)) names.add(name);
  const fields: CatalogField[] = [];
  for (const name of names) {
    const live = dictionary[name];
    const stat: FieldInfo | undefined = staticField(name);
    const type = live?.type ?? stat?.type ?? "unknown";
    fields.push({
      name,
      type,
      displayName: live?.displayName,
      definition: live?.definition ?? stat?.description ?? "",
      format: live?.format,
      benchmarkable: live?.benchmarkable,
      group: stat?.group,
      values: stat?.values,
      leadGrading: stat?.leadGrading,
      endpoints: endpointsFor(name, type, access?.endpoints),
    });
  }
  fields.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type.localeCompare(b.type)));
  return fields;
}

export function registerAccessTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "searchlight_list_access",
    {
      title: "List SearchLight access",
      description:
        "Show which organizations and account keys this API key can reach, the endpoints available, and optionally the live field dictionary. Call this first when the organization is unknown. Organization keys go in the organization argument of other tools; account keys go in account/accounts.",
      inputSchema: {
        include_dictionary: z.boolean().default(false).describe("Also return the full field dictionary (display names, definitions, formats)."),
        refresh: z.boolean().default(false).describe("Bypass the 10-minute cache."),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ include_dictionary, refresh }) => {
      const access = await ctx.client.getAccess(refresh);
      const orgs = access.organizations ?? [];
      const lines = [
        `Signed in as ${access.user}. ${orgs.length} organization(s).`,
        "",
        ...orgs.map((o) => `- ${o.organization}: ${(o.accounts ?? []).length} account(s): ${(o.accounts ?? []).join(", ")}`),
        "",
        `Endpoints: ${(access.endpoints ?? []).map((e) => `${e.endpoint} (${e.path})`).join("; ")}`,
        `Dictionary: ${Object.keys(access.dictionary ?? {}).length} fields${include_dictionary ? "" : " (pass include_dictionary=true to list them, or use searchlight_list_fields)"}.`,
      ];
      const structured: Record<string, unknown> = {
        user: access.user,
        organizations: orgs,
        endpoints: access.endpoints ?? [],
        dictionaryFieldCount: Object.keys(access.dictionary ?? {}).length,
      };
      if (include_dictionary) structured.dictionary = access.dictionary ?? {};
      return textResult(lines.join("\n"), structured);
    }),
  );

  server.registerTool(
    "searchlight_list_fields",
    {
      title: "List SearchLight fields",
      description:
        "Search the dimensions and metrics you can request in fields and filters. Uses the live dictionary from the API and falls back to a bundled reference. Filter by type, endpoint, or a text search over names and definitions.",
      inputSchema: {
        type: z.enum(["dimension", "metric"]).optional().describe("Only dimensions or only metrics."),
        endpoint: z.enum(["events", "benchmarks"]).optional().describe("Only fields the given endpoint supports."),
        search: z.string().optional().describe("Case-insensitive substring over name, display name, and definition."),
        include_lead_grading: z.boolean().default(true).describe("Include lead-grading fields, which return 0 or empty for accounts without that subscription."),
      },
      annotations: READ_ONLY,
    },
    guarded(async ({ type, endpoint, search, include_lead_grading }) => {
      let access: AccessInfo | undefined;
      let note = "";
      try {
        access = await ctx.client.getAccess();
      } catch (err) {
        note = `Live dictionary unavailable (${describeError(err)}); showing the bundled reference from the docs.`;
      }
      let fields = buildCatalog(access);
      if (type) fields = fields.filter((f) => f.type === type);
      if (endpoint) fields = fields.filter((f) => f.endpoints.includes(endpoint));
      if (!include_lead_grading) fields = fields.filter((f) => !f.leadGrading);
      if (search) {
        const q = search.toLowerCase();
        fields = fields.filter((f) =>
          [f.name, f.displayName ?? "", f.definition, f.group ?? ""].some((s) => s.toLowerCase().includes(q)),
        );
      }
      const rows = fields.map((f) => ({
        name: f.name,
        type: f.type,
        definition: f.definition,
        format: f.format ?? "",
        endpoints: f.endpoints.join("/"),
        values: f.values ? f.values.join(" | ") : "",
      }));
      const text = [
        `${fields.length} field(s)${access ? " (live dictionary)" : ""}.`,
        note,
        markdownTable(rows, ["name", "type", "definition", "format", "endpoints", "values"]),
      ]
        .filter(Boolean)
        .join("\n\n");
      return textResult(text, { source: access ? "live" : "static", note: note || undefined, fields });
    }),
  );
}
