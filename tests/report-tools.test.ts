import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchLightClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import {
  NO_SPEND,
  addComputedColumns,
  buildFunnel,
  checkReportRange,
  closedLagNote,
  registerReportTools,
} from "../src/tools/reports.js";

type Route = (url: URL) => { status?: number; body: unknown };

const ACCESS = {
  user: "me@example.com",
  organizations: [{ organization: "hb", accounts: ["hb-stl", "hb-nash"] }],
  endpoints: [],
  dictionary: {},
};

const PERF_FIELDS = "spend,leads,bookedCustomers,payingCustomers,soldRevenue,closedRevenue,bookRate,avgCostPerLead,roasClosed";
const FUNNEL_A = "customers,bookedCustomers,payingCustomers,canceledCustomers,stepBookRate,stepEstimateRate,stepSoldRate,stepCloseRate,customerCancelRate";
const FUNNEL_B = "adjustedType,customers,estimatedRevenue,soldRevenue,closedRevenue";

let client: Client | undefined;
let outDir: string;
beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-reports-"));
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await fs.rm(outDir, { recursive: true, force: true });
});

async function connect(route: Route) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = url.pathname === "/api" ? { body: ACCESS } : route(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_BASE_URL: "https://example.test", SEARCHLIGHT_OUTPUT_DIR: outDir });
  const ctx: AppContext = {
    config,
    client: new SearchLightClient({ apiKey: "sl_test", baseUrl: config.baseUrl, concurrency: 4, timeoutMs: 5000, fetchImpl, sleep: async () => {} }),
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReportTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client!.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    return { res, text, structured: res.structuredContent as Record<string, any> };
  };
  const events = () => urls.filter((u) => u.pathname !== "/api");
  const params = (u: URL) => Object.fromEntries(u.searchParams.entries());
  return { call, urls, events, params };
}

const perf = (o: Record<string, unknown>) => ({
  spend: 0,
  leads: 0,
  bookedCustomers: 0,
  payingCustomers: 0,
  soldRevenue: 0,
  closedRevenue: 0,
  bookRate: 0,
  avgCostPerLead: 0,
  roasClosed: 0,
  ...o,
});

describe("searchlight_performance_report", () => {
  it("sends the split and the unsplit totals request with the exact fields, and computes projected revenue", async () => {
    const { call, events, params } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f === `attributionChannel,${PERF_FIELDS}`) {
        return {
          body: [
            perf({ attributionChannel: "Google Ads", spend: 1000, leads: 40, bookedCustomers: 20, payingCustomers: 10, soldRevenue: 3000, closedRevenue: 5000, roasClosed: 5 }),
            perf({ attributionChannel: "Organic", spend: 0, leads: 10, bookedCustomers: 5, payingCustomers: 2, soldRevenue: 500, closedRevenue: 700, roasClosed: 0 }),
          ],
        };
      }
      if (f === PERF_FIELDS) {
        return { body: [perf({ spend: 1000, leads: 50, bookedCustomers: 25, payingCustomers: 12, soldRevenue: 3500, closedRevenue: 5700, bookRate: 0.5, avgCostPerLead: 20, roasClosed: 5.7 })] };
      }
      throw new Error(`unexpected fields ${f}`);
    });
    const { res, text, structured } = await call("searchlight_performance_report", {
      organization: "hb",
      account: "hb-stl",
      start: "2026-08-01",
      end: "2026-08-30",
      filters: { normalizedBusinessUnit: "HVAC" },
    });
    expect(res.isError).toBeFalsy();
    const sent = events();
    expect(sent).toHaveLength(2);
    expect(sent.every((u) => u.pathname === "/api/hb/events")).toBe(true);
    const byFields = Object.fromEntries(sent.map((u) => [u.searchParams.get("fields"), params(u)]));
    expect(byFields[`attributionChannel,${PERF_FIELDS}`]).toEqual({
      fields: `attributionChannel,${PERF_FIELDS}`,
      start: "2026-08-01",
      end: "2026-08-30",
      account: "hb-stl",
      normalizedBusinessUnit: "HVAC",
    });
    expect(byFields[PERF_FIELDS]).toEqual({
      fields: PERF_FIELDS,
      start: "2026-08-01",
      end: "2026-08-30",
      account: "hb-stl",
      normalizedBusinessUnit: "HVAC",
    });

    const [google, organic] = structured.rows;
    expect(google.attributionChannel).toBe("Google Ads");
    expect(google.projectedRevenue).toBe(8000);
    expect(google.roasProjected).toBe(8);
    expect(organic.projectedRevenue).toBe(1200);
    expect(organic.roasProjected).toBe(NO_SPEND);
    expect(organic.roasClosed).toBe(NO_SPEND);
    expect(structured.totals).toMatchObject({ attributionChannel: "Total", spend: 1000, leads: 50, bookRate: 0.5, projectedRevenue: 9200, roasProjected: 9.2 });
    expect(structured.untrackedSpendRows).toEqual([]);
    expect(structured.spendReconciliation).toMatchObject({ total: 1000, inRows: 1000, missing: 0 });
    expect(structured.apiCalls).toBe(3); // /api plus two events requests
    expect(text).toMatch(/Spend check: the rows carry all \$1,000\.00 of spend/);
    expect(text).not.toMatch(/spend with no tracked events/);
    expect(text).toMatch(/projectedRevenue = soldRevenue \+ closedRevenue/);
    expect(text).not.toMatch(/do not add up/);
  });

  it("adds a spend-with-no-tracked-events line per account when the split drops spend", async () => {
    const { call, events } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f === `account,campaign,${PERF_FIELDS}`) {
        return {
          body: [
            perf({ account: "STL", campaign: "Brand", spend: 600, leads: 30 }),
            perf({ account: "NSH", campaign: "Brand", spend: 300, leads: 10 }),
          ],
        };
      }
      if (f === "account,spend") return { body: [{ account: "STL", spend: 700 }, { account: "NSH", spend: 300 }] };
      if (f === PERF_FIELDS) return { body: [perf({ spend: 1000, leads: 40 })] };
      throw new Error(`unexpected fields ${f}`);
    });
    const { res, text, structured } = await call("searchlight_performance_report", {
      organization: "hb",
      by: ["account", "campaign"],
      start: "2026-08-01",
      end: "2026-08-30",
    });
    expect(res.isError).toBeFalsy();
    const fields = events().map((u) => u.searchParams.get("fields")).sort();
    expect(fields).toEqual([`account,campaign,${PERF_FIELDS}`, "account,spend", PERF_FIELDS].sort());
    for (const u of events()) {
      expect(u.pathname).toBe("/api/hb/events");
      expect(u.searchParams.get("start")).toBe("2026-08-01");
      expect(u.searchParams.get("end")).toBe("2026-08-30");
      expect(u.searchParams.has("interval")).toBe(false);
      expect(u.searchParams.has("account")).toBe(false);
    }
    expect(structured.untrackedSpendRows).toEqual([{ account: "STL", campaign: "(spend with no tracked events)", spend: 100 }]);
    expect(structured.spendReconciliation).toMatchObject({ total: 1000, inRows: 900, missing: 100 });
    expect(text).toMatch(/Spend with no tracked events: \$100\.00 of \$1,000\.00 total spend \(10\.0%\)/);
    expect(text).toMatch(/By account: STL \$100\.00 of \$700\.00/);
    expect(text).toMatch(/\| STL \| \(spend with no tracked events\) \| 100 \|/);
  });

  it("reconciles against the totals request when there is no account dimension", async () => {
    const { call, events } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f === `campaign,${PERF_FIELDS}`) return { body: [perf({ campaign: "Brand", spend: 970, leads: 50 })] };
      if (f === PERF_FIELDS) return { body: [perf({ spend: 1000, leads: 52 })] };
      throw new Error(`unexpected fields ${f}`);
    });
    const { text, structured } = await call("searchlight_performance_report", { organization: "hb", by: ["campaign"], start: "2026-08-01", end: "2026-08-30" });
    expect(events()).toHaveLength(2);
    expect(structured.untrackedSpendRows).toEqual([{ campaign: "(spend with no tracked events)", spend: 30 }]);
    expect(text).toMatch(/found by comparing with the totals request/);
    expect(text).toMatch(/do not add up to the totals line for leads rows 50 vs total 52/);
  });

  it("sorts by the requested column and limits rows, keeping the spend and totals lines", async () => {
    const { call } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f.startsWith("attributionChannel,")) {
        return { body: [perf({ attributionChannel: "A", spend: 10, leads: 1 }), perf({ attributionChannel: "B", spend: 5, leads: 9 }), perf({ attributionChannel: "C", spend: 1, leads: 5 })] };
      }
      return { body: [perf({ spend: 16, leads: 15 })] };
    });
    const { structured, text } = await call("searchlight_performance_report", { organization: "hb", start: "2026-08-01", end: "2026-08-30", sort_by: "leads", max_rows: 2 });
    expect(structured.rows.map((r: any) => r.attributionChannel)).toEqual(["B", "C"]);
    expect(structured.truncated).toBe(true);
    expect(text).toMatch(/Showing 2 of 3 rows/);
    expect(text).toMatch(/\| Total \|/);
  });

  it("writes a CSV when export is true", async () => {
    const { call } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f.startsWith("attributionChannel,")) return { body: [perf({ attributionChannel: "Google Ads", spend: 80, soldRevenue: 10, closedRevenue: 30 })] };
      return { body: [perf({ spend: 100 })] };
    });
    const { structured } = await call("searchlight_performance_report", { organization: "hb", start: "2026-08-01", end: "2026-08-30", export: true, excel_bom: false });
    expect(structured.export.path).toBe(path.join(outDir, "performance_hb_2026-08-01_2026-08-30_attributionChannel.csv"));
    expect(structured.export.rows).toBe(2);
    const csv = await fs.readFile(structured.export.path, "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("attributionChannel,spend,leads,bookedCustomers,payingCustomers,soldRevenue,closedRevenue,projectedRevenue,bookRate,avgCostPerLead,roasClosed,roasProjected");
    expect(lines[1]).toMatch(/^Google Ads,80,.*,40,.*,0\.5$/);
    expect(lines[2]).toMatch(/^\(spend with no tracked events\),20/);
  });

  it("refuses a range over 90 days without sending any request", async () => {
    const { call, urls } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_performance_report", { organization: "hb", start: "2026-01-01", end: "2026-04-30" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/120 days/);
    expect(urls).toEqual([]);
  });

  it("refuses the same dimension twice", async () => {
    const { call, urls } = await connect(() => ({ body: [] }));
    const { res } = await call("searchlight_performance_report", { organization: "hb", by: ["campaign", "campaign"], start: "2026-08-01", end: "2026-08-30" });
    expect(res.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe("searchlight_funnel_report", () => {
  const stageRows = (extra: Record<string, unknown> = {}) => [
    { ...extra, adjustedType: "lead-originated", customers: 40, estimatedRevenue: 0, soldRevenue: 0, closedRevenue: 0 },
    { ...extra, adjustedType: "booked", customers: 20, estimatedRevenue: 0, soldRevenue: 0, closedRevenue: 0 },
    { ...extra, adjustedType: "estimated", customers: 15, estimatedRevenue: 9000, soldRevenue: 0, closedRevenue: 0 },
    { ...extra, adjustedType: "sold", customers: 5, estimatedRevenue: 0, soldRevenue: 4000, closedRevenue: 0 },
    { ...extra, adjustedType: "closed", customers: 15, estimatedRevenue: 0, soldRevenue: 0, closedRevenue: 12000 },
    { ...extra, adjustedType: "canceled", customers: 5, estimatedRevenue: 0, soldRevenue: 0, closedRevenue: 0 },
  ];
  const rateRow = (extra: Record<string, unknown> = {}) => ({
    ...extra,
    customers: 100,
    bookedCustomers: 60,
    payingCustomers: 20,
    canceledCustomers: 5,
    stepBookRate: 0.6,
    stepEstimateRate: 0.7,
    stepSoldRate: 0.4,
    stepCloseRate: 0.75,
    customerCancelRate: 0.05,
  });

  it("sends request A and request B with the exact fields and builds the stage table", async () => {
    const { call, events, params } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f === FUNNEL_A) return { body: [rateRow()] };
      if (f === FUNNEL_B) return { body: stageRows() };
      throw new Error(`unexpected fields ${f}`);
    });
    const { res, text, structured } = await call("searchlight_funnel_report", { organization: "hb", accounts: ["hb-stl", "hb-nash"], start: "2026-08-01", end: "2026-08-30" });
    expect(res.isError).toBeFalsy();
    const byFields = Object.fromEntries(events().map((u) => [u.searchParams.get("fields"), { path: u.pathname, ...params(u) }]));
    expect(Object.keys(byFields).sort()).toEqual([FUNNEL_A, FUNNEL_B].sort());
    for (const f of [FUNNEL_A, FUNNEL_B]) {
      expect(byFields[f]).toEqual({ path: "/api/hb/events", fields: f, start: "2026-08-01", end: "2026-08-30", accounts: "hb-stl,hb-nash" });
    }
    const [funnel] = structured.funnels;
    expect(funnel.summary).toMatchObject({ customers: 100, bookedCustomers: 60 });
    expect(funnel.stages.map((s: any) => [s.stage, s.customers, s.stepRate, s.revenue])).toEqual([
      ["lead-originated", 40, null, null],
      ["booked", 20, 0.6, null],
      ["estimated", 15, 0.7, 9000],
      ["sold", 5, 0.4, 4000],
      ["closed", 15, 0.75, 12000],
      ["canceled", 5, 0.05, null],
    ]);
    expect(text).toMatch(/\| sold \| 5 \| 40\.0% \(stepSoldRate\) \| \$4,000\.00 \|/);
    expect(text).not.toMatch(/do not add up/);
  });

  it("builds one funnel per by value and says when stages do not add up", async () => {
    const { call, events } = await connect((url) => {
      const f = url.searchParams.get("fields")!;
      if (f === `attributionChannel,${FUNNEL_A}`) return { body: [rateRow({ attributionChannel: "Google Ads" }), { ...rateRow({ attributionChannel: "Organic" }), customers: 120 }] };
      if (f === `attributionChannel,${FUNNEL_B}`) return { body: [...stageRows({ attributionChannel: "Google Ads" }), ...stageRows({ attributionChannel: "Organic" }), { adjustedType: "", customers: 0, estimatedRevenue: 0, soldRevenue: 0, closedRevenue: 0 }] };
      throw new Error(`unexpected fields ${f}`);
    });
    const { text, structured } = await call("searchlight_funnel_report", { organization: "hb", by: "attributionChannel", start: "2026-08-01", end: "2026-08-30" });
    expect(events().map((u) => u.searchParams.get("fields")).sort()).toEqual([`attributionChannel,${FUNNEL_A}`, `attributionChannel,${FUNNEL_B}`].sort());
    expect(structured.funnels.map((f: any) => f.attributionChannel)).toEqual(["Organic", "Google Ads"]);
    expect(text).toMatch(/### attributionChannel: Google Ads/);
    expect(text).toMatch(/attributionChannel Organic: stages hold 100 customers, the unsplit count is 120/);
  });

  it("refuses a range over 90 days without sending any request", async () => {
    const { call, urls } = await connect(() => ({ body: [] }));
    const { res } = await call("searchlight_funnel_report", { organization: "hb", start: "2026-01-01", end: "2026-06-30" });
    expect(res.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe("report helpers", () => {
  it("addComputedColumns handles zero and missing spend", () => {
    expect(addComputedColumns({ spend: 200, soldRevenue: 100, closedRevenue: 500, roasClosed: 2.5 })).toEqual({
      spend: 200,
      soldRevenue: 100,
      closedRevenue: 500,
      roasClosed: 2.5,
      projectedRevenue: 600,
      roasProjected: 3,
    });
    expect(addComputedColumns({ spend: 0, soldRevenue: 100, closedRevenue: 0, roasClosed: 0 })).toMatchObject({ projectedRevenue: 100, roasProjected: NO_SPEND, roasClosed: NO_SPEND });
    expect(addComputedColumns({ soldRevenue: "10.5", closedRevenue: null })).toMatchObject({ projectedRevenue: 10.5, roasProjected: NO_SPEND });
  });

  it("checkReportRange allows 90 days and refuses 91", () => {
    expect(checkReportRange("2026-01-01", "2026-03-31")).toBe(90);
    expect(() => checkReportRange("2026-01-01", "2026-04-01")).toThrow(/91 days/);
  });

  it("closedLagNote applies within 35 days of today", () => {
    expect(closedLagNote("2026-10-31", "2026-11-11")).toMatch(/ends 11 day\(s\) ago/);
    expect(closedLagNote("2026-10-08", "2026-11-11")).toMatch(/ends 34 day\(s\) ago/);
    expect(closedLagNote("2026-10-07", "2026-11-11")).toBeNull();
  });

  it("buildFunnel lists an unknown stage after the known ones", () => {
    const { groups, unknownStages } = buildFunnel(undefined, [{ customers: 3 }], [
      { adjustedType: "booked", customers: 2 },
      { adjustedType: "rescheduled", customers: 1 },
    ]);
    expect(unknownStages).toEqual(["rescheduled"]);
    expect(groups[0]!.stages.map((s) => s.stage)).toEqual(["lead-originated", "booked", "estimated", "sold", "closed", "canceled", "rescheduled"]);
  });
});
