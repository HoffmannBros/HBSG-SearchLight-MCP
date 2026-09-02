/**
 * Live smoke test against the real SearchLight API through the built server.
 * Needs SEARCHLIGHT_API_KEY in .env (or the environment). Writes exports to
 * ./smoke-output. Usage: npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] && !m[1].startsWith("#")) env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}
if (process.env.SEARCHLIGHT_API_KEY) env.SEARCHLIGHT_API_KEY = process.env.SEARCHLIGHT_API_KEY;
if (!env.SEARCHLIGHT_API_KEY) {
  console.error("SEARCHLIGHT_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(2);
}
env.SEARCHLIGHT_OUTPUT_DIR = path.join(root, "smoke-output");

const bundle = path.join(root, "server", "index.cjs");
if (!fs.existsSync(bundle)) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  const body = text(result);
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${ms} ms)${result.isError ? " ERROR" : ""}`);
  console.log(body.length > 2500 ? `${body.slice(0, 2500)}\n... (${body.length} chars)` : body);
  if (result.isError) throw new Error(`${name} failed`);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

try {
  const access = await call("searchlight_list_access", {});
  const orgs = access.organizations as Array<{ organization: string; accounts: string[] }>;
  const org = orgs[0]?.organization;
  if (!org) throw new Error("no organizations");

  await call("searchlight_list_fields", { search: "roas" });

  const today = new Date();
  const end = iso(new Date(today.getTime() - 86_400_000));
  const start30 = iso(new Date(today.getTime() - 31 * 86_400_000));
  await call("searchlight_query_events", {
    organization: org,
    fields: ["account", "spend", "leads", "avgCostPerLead", "roasPotential"],
    start: start30,
    end,
  });

  await call("searchlight_query_events", {
    organization: org,
    fields: ["account", "attributionCategory", "leads", "closedRevenue"],
    start: start30,
    end,
    filters: { attributionCategory: ["or", "Organic", "Advertising"] },
    max_rows: 20,
  });

  const start6m = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1)));
  await call("searchlight_export_events_csv", {
    organization: org,
    fields: ["account", "campaign", "spend", "leads", "revenuePotential", "roasPotential"],
    start: start6m,
    end,
    interval: "month",
    filename: "smoke_events_6m",
  });

  const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevMonth = iso(prev).slice(0, 7);
  await call("searchlight_get_benchmarks", { organization: org, fields: ["bookRate", "matchRate", "roasClosed"], month: prevMonth });
  await call("searchlight_export_benchmarks_csv", {
    organization: org,
    fields: ["bookRate", "avgCostPerLead", "roasClosed"],
    start_month: iso(new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() - 2, 1))).slice(0, 7),
    end_month: prevMonth,
    filename: "smoke_benchmarks",
  });

  await call("searchlight_get_insights", { organization: org, max_items: 3 });
  await call("searchlight_export_insights_csv", { organization: org, filename: "smoke_insights" });

  await call("searchlight_api_call", { path: "/api", max_items: 5 });
  console.log("\nSMOKE OK");
} finally {
  await client.close();
}
