import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { DRAFT_07_ONLY_KEYWORDS, JSON_SCHEMA_DIALECT } from "../src/schema-compat.js";

const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "server", "index.cjs");

const EXPECTED_TOOLS = [
  "searchlight_list_access",
  "searchlight_list_fields",
  "searchlight_query_events",
  "searchlight_export_events_csv",
  "searchlight_get_benchmarks",
  "searchlight_export_benchmarks_csv",
  "searchlight_get_insights",
  "searchlight_export_insights_csv",
  "searchlight_api_call",
];

describe("built server over stdio", () => {
  let client: Client;

  beforeAll(async () => {
    if (!fs.existsSync(bundle)) throw new Error(`Build first: ${bundle} is missing (npm run build).`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      env: { PATH: process.env.PATH ?? "", SEARCHLIGHT_API_KEY: "", HOME: process.env.HOME ?? "" },
      cwd: root,
      stderr: "pipe",
    });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("exposes exactly the nine SearchLight tools with read-only annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
  });

  it("falls back to the bundled field reference when the API is unreachable", async () => {
    const result = await client.callTool({ name: "searchlight_list_fields", arguments: { search: "bookRate" } });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(result.isError).toBeFalsy();
    expect(text).toContain("bookRate");
    expect(text).toMatch(/bundled reference/);
  });

  it("returns a configuration error, not a crash, when the key is missing", async () => {
    const result = await client.callTool({
      name: "searchlight_query_events",
      arguments: { fields: ["spend"], start: "2026-01-01", end: "2026-01-31" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/API key/);
  });

  it("validates dates before touching the network", async () => {
    const result = await client.callTool({
      name: "searchlight_query_events",
      arguments: { fields: ["spend"], start: "2026-01-01", end: "2026-06-30", interval: "total" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/90 days/);
  });

  it("declares a dialect Claude's Ajv 2020 client validator can compile", async () => {
    // Reproduces the client-side failure: an Ajv 2020 instance refuses any
    // schema declaring draft-07, which is what MCP SDK 1.x emits by default.
    const { tools } = await client.listTools();
    const ajv = new Ajv2020({ strict: false });
    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        expect((schema as { $schema?: string }).$schema, `${tool.name}.${kind}`).toBe(JSON_SCHEMA_DIALECT);
        expect(() => ajv.compile(schema as object), `${tool.name}.${kind}`).not.toThrow();
      }
    }
  });

  it("uses no draft-07-only keyword that the dialect restamp would silently change", async () => {
    const { tools } = await client.listTools();
    const offenders: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${at}[${i}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((DRAFT_07_ONLY_KEYWORDS as readonly string[]).includes(key)) offenders.push(`${at}.${key}`);
        walk(value, `${at}.${key}`);
      }
    };
    for (const tool of tools) {
      walk(tool.inputSchema, `${tool.name}.inputSchema`);
      walk(tool.outputSchema, `${tool.name}.outputSchema`);
    }
    expect(offenders).toEqual([]);
  });

  it("refuses an over-90-day events call through the raw API tool without spending a request", async () => {
    const result = await client.callTool({
      name: "searchlight_api_call",
      arguments: { path: "/api/acme/events", params: { fields: "leads", start: "2026-06-01", end: "2026-08-30" } },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(text).toMatch(/91 days/);
    expect(text).toMatch(/interval/);
    // A missing key would mean the guard never ran and the client got there first.
    expect(text).not.toMatch(/API key/);
  });
});
