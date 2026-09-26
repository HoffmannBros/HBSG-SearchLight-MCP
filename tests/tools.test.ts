import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchLightClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { localToday } from "../src/dates.js";
import { registerCompareTools } from "../src/tools/compare.js";
import { registerEventsTools } from "../src/tools/events.js";
import { registerRawTools } from "../src/tools/raw.js";

type Route = (url: URL) => { status?: number; body: unknown };

const ACCESS = {
  user: "me@example.com",
  organizations: [{ organization: "hb", accounts: ["hb-stl", "hb-nash"] }],
  endpoints: [],
  dictionary: {
    spend: { type: "metric" },
    leads: { type: "metric" },
    bookRate: { type: "metric" },
    avgCostPerLead: { type: "metric" },
    campaign: { type: "dimension" },
  },
};

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(route: Route) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = url.pathname === "/api" ? { body: ACCESS } : route(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_BASE_URL: "https://example.test" });
  const ctx: AppContext = {
    config,
    client: new SearchLightClient({ apiKey: "sl_test", baseUrl: config.baseUrl, concurrency: 4, timeoutMs: 5000, fetchImpl, sleep: async () => {} }),
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEventsTools(server, ctx);
  registerCompareTools(server, ctx);
  registerRawTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client!.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    return { res, text, structured: res.structuredContent as Record<string, any> };
  };
  return { call, urls, apiPaths: () => urls.filter((u) => u.pathname !== "/api").map((u) => u.pathname) };
}

describe("strict organization paths", () => {
  it("reroutes an account key given as organization through its parent", async () => {
    const { call, urls } = await connect(() => ({ body: [{ spend: 5 }] }));
    const { res, text } = await call("searchlight_query_events", {
      organization: "hb-stl",
      fields: ["spend"],
      start: "2026-08-01",
      end: "2026-08-31",
    });
    expect(res.isError).toBeFalsy();
    const events = urls.find((u) => u.pathname.endsWith("/events"))!;
    expect(events.pathname).toBe("/api/hb/events");
    expect(events.searchParams.get("account")).toBe("hb-stl");
    expect(text).toMatch(/went through its organization "hb"/);
  });

  it("refuses an account outside the organization without calling events", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_query_events", {
      organization: "hb",
      accounts: ["elsewhere"],
      fields: ["spend"],
      start: "2026-08-01",
      end: "2026-08-31",
    });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/"elsewhere" is not under organization "hb"/);
    expect(apiPaths()).toEqual([]);
  });

  it("still sends the request when /api itself fails", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.pathname);
      if (url.pathname === "/api") return new Response("{}", { status: 502 });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_DEFAULT_ORGANIZATION: "hb" });
    const ctx: AppContext = {
      config,
      client: new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 1, timeoutMs: 5000, fetchImpl, sleep: async () => {}, maxAttempts: 1 }),
    };
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerEventsTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const res = await client.callTool({ name: "searchlight_query_events", arguments: { fields: ["spend"], start: "2026-08-01", end: "2026-08-02" } });
    expect(res.isError).toBeFalsy();
    expect(urls).toEqual(["/api", "/api/hb/events"]);
  });

  it("the raw tool refuses an account key in the path", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_api_call", { path: "/api/hb-nash/events", params: { fields: "spend", start: "2026-08-01", end: "2026-08-02" } });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/Refused before sending/);
    expect(text).toMatch(/account=hb-nash/);
    expect(apiPaths()).toEqual([]);
  });
});

describe("searchlight_compare_to_benchmark", () => {
  const bench = [
    { series: "benchmark", cohortAccounts: 600, bookRate: 0.41, avgCostPerLead: 50 },
    { series: "p10", cohortAccounts: 600, bookRate: 0.2, avgCostPerLead: 20 },
    { series: "p25", cohortAccounts: 600, bookRate: 0.3, avgCostPerLead: 30 },
    { series: "p50", cohortAccounts: 600, bookRate: 0.4, avgCostPerLead: 40 },
    { series: "p75", cohortAccounts: 600, bookRate: 0.5, avgCostPerLead: 60 },
    { series: "p90", cohortAccounts: 600, bookRate: 0.6, avgCostPerLead: 80 },
  ];

  it("joins each account to the distribution and reads direction per metric", async () => {
    const { call, urls } = await connect((url) =>
      url.pathname.endsWith("/benchmarks")
        ? { body: bench }
        : {
            body: [
              { accountKey: "hb-stl", account: "STL", bookRate: 0.65, avgCostPerLead: 15, spend: 1000 },
              { accountKey: "hb-nash", account: "Nash", bookRate: 0.25, avgCostPerLead: 0, spend: 0 },
            ],
          },
    );
    const { res, structured } = await call("searchlight_compare_to_benchmark", {
      organization: "hb",
      month: "2026-02",
      metrics: ["bookRate", "avgCostPerLead"],
    });
    expect(res.isError).toBeFalsy();
    const events = urls.find((u) => u.pathname.endsWith("/events"))!;
    expect(events.searchParams.get("start")).toBe("2026-02-01");
    expect(events.searchParams.get("end")).toBe("2026-02-28");
    expect(events.searchParams.get("fields")).toBe("accountKey,account,bookRate,avgCostPerLead,spend");
    const benchUrl = urls.find((u) => u.pathname.endsWith("/benchmarks"))!;
    expect(benchUrl.searchParams.get("month")).toBe("2026-02");
    expect(benchUrl.searchParams.get("fields")).toBe("bookRate,avgCostPerLead");

    const rows = structured.rows as Array<Record<string, unknown>>;
    const pick = (acct: string, metric: string) => rows.find((r) => r.accountKey === acct && r.metric === metric)!;
    expect(pick("hb-stl", "bookRate")).toMatchObject({ value: 0.65, benchmark: 0.41, standing: "top 10%", cohortAccounts: 600 });
    expect(pick("hb-stl", "avgCostPerLead")).toMatchObject({ standing: "top 10%", band: "<p10" });
    expect(pick("hb-nash", "bookRate").standing).toBe("bottom 25%");
    expect(pick("hb-nash", "avgCostPerLead").standing).toBe("n/a (no spend)");
  });

  it("returns own numbers with a note when the benchmark is still being gathered", async () => {
    const { call } = await connect((url) =>
      url.pathname.endsWith("/benchmarks") ? { status: 503, body: { error: "gathering" } } : { body: [{ accountKey: "hb-stl", account: "STL", bookRate: 0.4 }] },
    );
    const { res, text, structured } = await call("searchlight_compare_to_benchmark", { organization: "hb", month: "2026-02", metrics: ["bookRate"] });
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/still being gathered/);
    expect(structured.rows[0]).toMatchObject({ value: 0.4, standing: "" });
  });

  it("refuses a filter on a field benchmarks cannot filter, before any request", async () => {
    const { call, urls } = await connect(() => ({ body: [] }));
    const { res } = await call("searchlight_compare_to_benchmark", { organization: "hb", month: "2026-02", filters: { campaign: "x" } });
    expect(res.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });

  it("uses month to date for the current month", async () => {
    const { call, urls } = await connect((url) => ({ body: url.pathname.endsWith("/benchmarks") ? bench : [] }));
    const today = localToday();
    await call("searchlight_compare_to_benchmark", { organization: "hb", month: today.slice(0, 7), metrics: ["bookRate"] });
    const events = urls.find((u) => u.pathname.endsWith("/events"))!;
    expect(events.searchParams.get("start")).toBe(`${today.slice(0, 7)}-01`);
    expect(events.searchParams.get("end")).toBe(today);
  });
});

describe("searchlight_compare_periods", () => {
  it("defaults to the preceding period and joins on dimensions", async () => {
    const { call, urls } = await connect((url) =>
      url.searchParams.get("start") === "2026-08-01"
        ? { body: [{ campaign: "a", spend: 100, leads: 10 }, { campaign: "b", spend: 10, leads: 1 }] }
        : { body: [{ campaign: "a", spend: 50, leads: 10 }, { campaign: "b", spend: 40, leads: 2 }] },
    );
    const { res, structured, text } = await call("searchlight_compare_periods", {
      organization: "hb",
      fields: ["campaign", "spend", "leads"],
      start: "2026-08-01",
      end: "2026-08-31",
      sort_by: "spend",
    });
    expect(res.isError).toBeFalsy();
    const windows = urls.filter((u) => u.pathname.endsWith("/events")).map((u) => `${u.searchParams.get("start")}..${u.searchParams.get("end")}`);
    expect(windows.sort()).toEqual(["2026-07-01..2026-07-31", "2026-08-01..2026-08-31"]);
    expect(structured.dimensions).toEqual(["campaign"]);
    expect(structured.rows[0]).toMatchObject({ campaign: "a", spend: 100, spend_prev: 50, spend_change: 50, spend_pct: 1 });
    expect(structured.rows[1]).toMatchObject({ campaign: "b", spend_change: -30, leads_pct: -0.5 });
    expect(text).toMatch(/2026-08-01 to 2026-08-31 vs 2026-07-01 to 2026-07-31/);
  });

  it("refuses a period over 90 days and a sort_by that is not a metric", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const long = await call("searchlight_compare_periods", { organization: "hb", fields: ["spend"], start: "2026-01-01", end: "2026-06-30" });
    expect(long.res.isError).toBe(true);
    expect(long.text).toMatch(/90 days/);
    const badSort = await call("searchlight_compare_periods", { organization: "hb", fields: ["campaign", "spend"], start: "2026-08-01", end: "2026-08-31", sort_by: "campaign" });
    expect(badSort.res.isError).toBe(true);
    expect(apiPaths()).toEqual([]);
  });
});
