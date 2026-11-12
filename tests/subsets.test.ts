import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchLightApiError, SearchLightClient, SearchLightConfigError, type AccessInfo } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { RESERVED_PARAMS } from "../src/filters.js";
import { fetchEventsChunked } from "../src/chunking.js";
import { assertSubsetAllowed, checkScope, rawPathProblem } from "../src/scope.js";
import { registerAccessTools } from "../src/tools/access.js";
import { registerBenchmarkTools } from "../src/tools/benchmarks.js";
import { registerCompareTools } from "../src/tools/compare.js";
import { registerEventsTools } from "../src/tools/events.js";
import { registerInsightTools } from "../src/tools/insights.js";
import { registerRawTools } from "../src/tools/raw.js";

// Made-up keys only.
const WITH_SUBSETS: AccessInfo = {
  user: "me@example.com",
  organizations: [
    {
      organization: "hb",
      accounts: ["hb-stl", "hb-nash", "hb-den"],
      subsets: [
        { subset: "hb-east", name: "East", accounts: ["hb-stl", "hb-nash"] },
        { subset: "hb-west", name: "West", accounts: ["hb-den"] },
      ],
    },
    { organization: "other", accounts: ["ot-a", "ot-b"] },
    { organization: "solo", accounts: [] },
  ],
  endpoints: [],
  dictionary: {
    spend: { type: "metric" },
    leads: { type: "metric" },
    bookRate: { type: "metric" },
    accountKey: { type: "dimension" },
    campaign: { type: "dimension" },
  },
};

const NO_SUBSETS: AccessInfo = {
  ...WITH_SUBSETS,
  organizations: [
    { organization: "hb", accounts: ["hb-stl", "hb-nash"] },
    { organization: "other", accounts: ["ot-a"] },
  ],
};

describe("checkScope with subsets", () => {
  it("passes a known subset and accounts inside it through", () => {
    expect(checkScope(WITH_SUBSETS, "hb", ["hb-stl"], "hb-east")).toEqual({
      organization: "hb",
      accounts: ["hb-stl"],
      subset: "hb-east",
      notes: [],
    });
  });

  it("refuses an unknown subset and names the subsets the organization lists", () => {
    expect(() => checkScope(WITH_SUBSETS, "hb", undefined, "hb-north")).toThrow(SearchLightConfigError);
    expect(() => checkScope(WITH_SUBSETS, "hb", undefined, "hb-north")).toThrow(/"hb-north" is not a subset of organization "hb".*hb-east, hb-west/);
    expect(() => checkScope(WITH_SUBSETS, "other", undefined, "hb-east")).toThrow(/lists no subsets/);
  });

  it("refuses an account outside the subset", () => {
    expect(() => checkScope(WITH_SUBSETS, "hb", ["hb-den"], "hb-east")).toThrow(/"hb-den" is not in subset "hb-east" of "hb".*hb-stl, hb-nash/);
  });

  it("applies the subset check to an account key rerouted through its organization", () => {
    expect(checkScope(WITH_SUBSETS, "hb-stl", undefined, "hb-east")).toMatchObject({ organization: "hb", accounts: ["hb-stl"], subset: "hb-east" });
    expect(() => checkScope(WITH_SUBSETS, "hb-den", undefined, "hb-east")).toThrow(/not in subset "hb-east"/);
  });

  it("reroutes a subset key given as the organization, with a note", () => {
    const scope = checkScope(WITH_SUBSETS, "hb-west", undefined);
    expect(scope).toMatchObject({ organization: "hb", accounts: undefined, subset: "hb-west" });
    expect(scope.notes[0]).toMatch(/"hb-west" is a subset of organization "hb".*subset=hb-west.*2026-10-12/);
    expect(checkScope(WITH_SUBSETS, "hb-west", undefined, "hb-west").subset).toBe("hb-west");
  });

  it("checks accounts against a rerouted subset and refuses a second subset", () => {
    expect(() => checkScope(WITH_SUBSETS, "hb-west", ["hb-stl"])).toThrow(/not in subset "hb-west"/);
    expect(() => checkScope(WITH_SUBSETS, "hb-west", undefined, "hb-east")).toThrow(/also given/);
  });

  it("mentions subsets and - when nothing matches", () => {
    expect(() => checkScope(WITH_SUBSETS, "nope", undefined)).toThrow(/organization, account or subset.*Organizations: hb, other, solo.*"-"/);
  });
});

describe("checkScope with the - organization", () => {
  it("accepts - with no accounts and with accounts from any organization", () => {
    expect(checkScope(WITH_SUBSETS, "-", undefined)).toEqual({ organization: "-", accounts: undefined, subset: undefined, notes: [] });
    expect(checkScope(WITH_SUBSETS, "-", ["hb-stl", "ot-b", "solo"]).accounts).toEqual(["hb-stl", "ot-b", "solo"]);
  });

  it("refuses accounts outside the union of reachable accounts", () => {
    expect(() => checkScope(WITH_SUBSETS, "-", ["hb-stl", "zzz"])).toThrow(/"zzz" is not an account this key can reach/);
  });

  it("refuses a subset with -, before and after /api is loaded", () => {
    expect(() => checkScope(WITH_SUBSETS, "-", undefined, "hb-east")).toThrow(/cannot be combined with organization "-"/);
    expect(() => assertSubsetAllowed("-", "hb-east")).toThrow(SearchLightConfigError);
    expect(() => assertSubsetAllowed("hb", "hb-east")).not.toThrow();
    expect(() => assertSubsetAllowed("-", undefined)).not.toThrow();
  });
});

describe("rawPathProblem with subsets and -", () => {
  it("accepts - as the path segment and checks accounts against the union", () => {
    expect(rawPathProblem(WITH_SUBSETS, "/api/-/events", { accounts: "hb-stl,ot-a" })).toBeUndefined();
    expect(rawPathProblem(WITH_SUBSETS, "/api/-/events", { account: "zzz" })).toMatch(/"zzz"/);
    expect(rawPathProblem(WITH_SUBSETS, "/api/-/events", { subset: "hb-east" })).toMatch(/cannot be combined/);
  });

  it("applies subset checks when subset is in the params", () => {
    expect(rawPathProblem(WITH_SUBSETS, "/api/hb/events", { subset: "hb-east", account: "hb-stl" })).toBeUndefined();
    expect(rawPathProblem(WITH_SUBSETS, "/api/hb/events", { subset: "nope" })).toMatch(/not a subset/);
    expect(rawPathProblem(WITH_SUBSETS, "/api/hb/events", { subset: "hb-east", account: "hb-den" })).toMatch(/not in subset/);
  });

  it("flags a subset key in the path with the corrected route", () => {
    expect(rawPathProblem(WITH_SUBSETS, "/api/hb-east/events", {})).toMatch(/subset of "hb".*\/api\/hb\/\.\.\. with subset=hb-east/);
    expect(rawPathProblem(WITH_SUBSETS, "/api/hb-stl/events", {})).toMatch(/account=hb-stl/);
  });
});

describe("client support", () => {
  it("reserves subset as a request parameter", () => {
    expect(RESERVED_PARAMS.has("subset")).toBe(true);
  });

  it("listAccounts returns the union for -, and the subset's accounts with a subset", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(WITH_SUBSETS), { status: 200 })) as typeof fetch;
    const c = new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 1, timeoutMs: 5000, fetchImpl });
    expect(await c.listAccounts("-")).toEqual(["hb-stl", "hb-nash", "hb-den", "ot-a", "ot-b", "solo"]);
    expect(await c.listAccounts("hb", "hb-east")).toEqual(["hb-stl", "hb-nash"]);
    expect(await c.listAccounts("hb")).toEqual(["hb-stl", "hb-nash", "hb-den"]);
  });

  it("caches /api for an hour by default", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify(NO_SUBSETS), { status: 200 });
    }) as typeof fetch;
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const c = new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 1, timeoutMs: 5000, fetchImpl });
      await c.getAccess();
      now += 59 * 60_000;
      await c.getAccess();
      expect(calls).toBe(1);
      now += 2 * 60_000;
      await c.getAccess();
      expect(calls).toBe(2);
      await c.getAccess(true);
      expect(calls).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  async function hintOf(body: unknown, params: Record<string, string> = {}): Promise<string> {
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 404 })) as typeof fetch;
    const c = new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 1, timeoutMs: 5000, fetchImpl, maxAttempts: 1 });
    const err = await c.get("/api/hb/events", { fields: "leads", start: "2026-08-01", end: "2026-08-02", ...params }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchLightApiError);
    return (err as SearchLightApiError).hint;
  }

  it("gives each 404 code its own hint", async () => {
    const accounts = await hintOf({ error: "x is not under hb", code: "inaccessible-accounts" });
    expect(accounts).toMatch(/An account in this request is not under the organization/);
    expect(accounts).not.toMatch(/or not in subset/);
    expect(await hintOf({ error: "x", code: "inaccessible-accounts" }, { subset: "hb-east" })).toMatch(/or not in subset "hb-east"/);
    const org = await hintOf({ error: "Unknown or inaccessible organization", code: "inaccessible-organization" });
    expect(org).toMatch(/The organization in "\/api\/hb\/events" is not accessible with this key/);
    // The API answers an unknown subset with inaccessible-organization too.
    expect(await hintOf({ error: "x", code: "inaccessible-organization" }, { subset: "nope" })).toMatch(/or it has no subset "nope"/);
  });
});

// ---- Tools, against a fake fetch ----

let client: Client | undefined;
let outDir = "";
beforeAll(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-subsets-"));
});
afterAll(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
});

type Route = (url: URL) => { status?: number; body: unknown };

async function connect(route: Route, access: AccessInfo = WITH_SUBSETS) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = url.pathname === "/api" ? { body: access } : route(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_BASE_URL: "https://example.test", SEARCHLIGHT_OUTPUT_DIR: outDir });
  const ctx: AppContext = {
    config,
    client: new SearchLightClient({ apiKey: "sl_test", baseUrl: config.baseUrl, concurrency: 4, timeoutMs: 5000, fetchImpl, sleep: async () => {} }),
  };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAccessTools(server, ctx);
  registerEventsTools(server, ctx);
  registerBenchmarkTools(server, ctx);
  registerInsightTools(server, ctx);
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
  const api = () => urls.filter((u) => u.pathname !== "/api");
  return { call, urls, api, apiPaths: () => api().map((u) => u.pathname) };
}

const params = (u: URL) => Object.fromEntries(u.searchParams.entries());

describe("subset is sent by every typed tool that takes an organization", () => {
  const bench = [{ series: "benchmark", cohortAccounts: 600, bookRate: 0.4 }];
  const route: Route = (url) => ({ body: url.pathname.endsWith("/benchmarks") ? bench : url.pathname.endsWith("/insights") ? [] : [{ spend: 1, bookRate: 0.5 }] });

  it("searchlight_query_events", async () => {
    const { call, api } = await connect(route);
    const { res, structured } = await call("searchlight_query_events", { organization: "hb", subset: "hb-east", fields: ["spend"], start: "2026-08-01", end: "2026-08-07" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/events"]);
    expect(params(api()[0]!)).toEqual({ fields: "spend", start: "2026-08-01", end: "2026-08-07", subset: "hb-east" });
    expect(structured.subset).toBe("hb-east");
  });

  it("searchlight_export_events_csv", async () => {
    const { call, api } = await connect(route);
    const { res, structured } = await call("searchlight_export_events_csv", {
      organization: "hb",
      subset: "hb-east",
      account: "hb-nash",
      fields: ["spend"],
      start: "2026-08-01",
      end: "2026-08-07",
      filename: "subset-test",
    });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/events"]);
    expect(params(api()[0]!)).toEqual({ fields: "spend", start: "2026-08-01", end: "2026-08-07", account: "hb-nash", subset: "hb-east" });
    expect(structured.subset).toBe("hb-east");
  });

  it("searchlight_get_benchmarks", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_get_benchmarks", { organization: "hb", subset: "hb-east", fields: ["bookRate"], month: "2026-08" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/benchmarks"]);
    expect(params(api()[0]!)).toEqual({ fields: "bookRate", subset: "hb-east", month: "2026-08" });
  });

  it("searchlight_export_benchmarks_csv", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_export_benchmarks_csv", { organization: "hb", subset: "hb-west", fields: ["bookRate"], months: ["2026-07", "2026-08"], filename: "subset-bench" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/benchmarks", "/api/hb/benchmarks"]);
    expect(api().map(params).sort((a, b) => a.month!.localeCompare(b.month!))).toEqual([
      { fields: "bookRate", subset: "hb-west", month: "2026-07" },
      { fields: "bookRate", subset: "hb-west", month: "2026-08" },
    ]);
  });

  it("searchlight_get_insights", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_get_insights", { organization: "hb", subset: "hb-east", start: "2026-08-01", end: "2026-08-07" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/insights"]);
    expect(params(api()[0]!)).toEqual({ start: "2026-08-01", end: "2026-08-07", subset: "hb-east" });
  });

  it("searchlight_export_insights_csv", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_export_insights_csv", { organization: "hb", subset: "hb-east", fields: ["account", "kind"], filename: "subset-insights" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/insights"]);
    expect(params(api()[0]!)).toEqual({ fields: "account,kind", subset: "hb-east" });
  });

  it("searchlight_compare_to_benchmark sends it on both requests", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_compare_to_benchmark", { organization: "hb", subset: "hb-east", month: "2026-02", metrics: ["bookRate"] });
    expect(res.isError).toBeFalsy();
    const events = api().find((u) => u.pathname === "/api/hb/events")!;
    const benchUrl = api().find((u) => u.pathname === "/api/hb/benchmarks")!;
    expect(params(events)).toEqual({ fields: "accountKey,account,bookRate", start: "2026-02-01", end: "2026-02-28", subset: "hb-east" });
    expect(params(benchUrl)).toEqual({ fields: "bookRate", subset: "hb-east", month: "2026-02" });
  });

  it("searchlight_compare_periods sends it on both periods", async () => {
    const { call, api } = await connect(route);
    const { res } = await call("searchlight_compare_periods", { organization: "hb", subset: "hb-east", fields: ["spend"], start: "2026-08-01", end: "2026-08-31" });
    expect(res.isError).toBeFalsy();
    expect(api().map(params).sort((a, b) => a.start!.localeCompare(b.start!))).toEqual([
      { fields: "spend", start: "2026-07-01", end: "2026-07-31", subset: "hb-east" },
      { fields: "spend", start: "2026-08-01", end: "2026-08-31", subset: "hb-east" },
    ]);
  });
});

describe("subset and - refusals and reroutes in the tools", () => {
  const events = { fields: ["spend"], start: "2026-08-01", end: "2026-08-07" };

  it("refuses an unknown subset with no request sent", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_query_events", { organization: "hb", subset: "hb-north", ...events });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/not a subset of organization "hb".*hb-east, hb-west/);
    expect(apiPaths()).toEqual([]);
  });

  it("refuses an account outside the subset with no request sent", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const bench = await call("searchlight_get_benchmarks", { organization: "hb", subset: "hb-east", account: "hb-den", fields: ["bookRate"], month: "2026-08" });
    expect(bench.res.isError).toBe(true);
    expect(bench.text).toMatch(/"hb-den" is not in subset "hb-east"/);
    const ev = await call("searchlight_query_events", { organization: "hb", subset: "hb-west", accounts: ["hb-stl"], ...events });
    expect(ev.res.isError).toBe(true);
    expect(apiPaths()).toEqual([]);
  });

  it("reroutes a subset key passed as organization, with a note", async () => {
    const { call, api } = await connect(() => ({ body: [{ spend: 3 }] }));
    const { res, text, structured } = await call("searchlight_query_events", { organization: "hb-east", ...events });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/hb/events"]);
    expect(params(api()[0]!)).toEqual({ fields: "spend", start: "2026-08-01", end: "2026-08-07", subset: "hb-east" });
    expect(text).toMatch(/"hb-east" is a subset of organization "hb"/);
    expect(structured.notes[0]).toMatch(/subset=hb-east/);
  });

  it("accepts - and sends it in the path", async () => {
    const { call, api } = await connect(() => ({ body: [{ accountKey: "hb-stl", spend: 1 }] }));
    const { res } = await call("searchlight_query_events", { organization: "-", accounts: ["hb-stl", "ot-a"], fields: ["accountKey", "spend"], start: "2026-08-01", end: "2026-08-07" });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/-/events"]);
    expect(params(api()[0]!)).toEqual({ fields: "accountKey,spend", start: "2026-08-01", end: "2026-08-07", accounts: "hb-stl,ot-a" });
  });

  it("refuses an account outside every organization with -", async () => {
    const { call, apiPaths } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_query_events", { organization: "-", account: "zzz", ...events });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/"zzz" is not an account this key can reach/);
    expect(apiPaths()).toEqual([]);
  });

  it("refuses subset with - before any request, including /api", async () => {
    const { call, urls } = await connect(() => ({ body: [] }));
    const { res, text } = await call("searchlight_get_insights", { organization: "-", subset: "hb-east" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/cannot be combined with organization "-"/);
    expect(urls).toEqual([]);
  });

  it("the raw tool accepts - and refuses an unknown subset", async () => {
    const { call, api } = await connect(() => ({ body: [{ leads: 1 }] }));
    const ok = await call("searchlight_api_call", { path: "/api/-/events", params: { fields: "leads", start: "2026-08-01", end: "2026-08-02" } });
    expect(ok.res.isError).toBeFalsy();
    expect(api().map((u) => u.pathname)).toEqual(["/api/-/events"]);
    expect(params(api()[0]!)).toEqual({ fields: "leads", start: "2026-08-01", end: "2026-08-02" });
    const bad = await call("searchlight_api_call", { path: "/api/hb/events", params: { fields: "leads", start: "2026-08-01", end: "2026-08-02", subset: "nope" } });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toMatch(/Refused before sending.*not a subset/);
    expect(api()).toHaveLength(1);
  });
});

describe("account splitting", () => {
  /** Rejects any request that is not for a single account as too large. */
  const splitRoute: Route = (url) => {
    const account = url.searchParams.get("account");
    if (!account) return { status: 400, body: { error: "Too many rows; narrow the request." } };
    return { body: [{ accountKey: account, spend: 1 }] };
  };

  it("uses the subset's accounts, and sends subset on every chunk", async () => {
    const { call, api } = await connect(splitRoute);
    const { res, structured } = await call("searchlight_query_events", { organization: "hb", subset: "hb-east", fields: ["accountKey", "spend"], start: "2026-08-01", end: "2026-08-07" });
    expect(res.isError).toBeFalsy();
    const sent = api().map(params);
    expect(sent[0]).toEqual({ fields: "accountKey,spend", start: "2026-08-01", end: "2026-08-07", subset: "hb-east" });
    expect(sent.slice(1).sort((a, b) => a.account!.localeCompare(b.account!))).toEqual([
      { fields: "accountKey,spend", start: "2026-08-01", end: "2026-08-07", account: "hb-nash", subset: "hb-east" },
      { fields: "accountKey,spend", start: "2026-08-01", end: "2026-08-07", account: "hb-stl", subset: "hb-east" },
    ]);
    expect(structured.splits).toBe(1);
    expect(structured.apiCalls).toBe(4); // /api, the rejected request, two chunks
  });

  it("uses the subset's accounts for insights", async () => {
    const { call, api } = await connect((url) =>
      url.searchParams.get("account") ? { body: [] } : { status: 400, body: { error: "Too many documents" } },
    );
    const { res } = await call("searchlight_get_insights", { organization: "hb", subset: "hb-east" });
    expect(res.isError).toBeFalsy();
    const sent = api().map(params);
    expect(sent[0]).toEqual({ subset: "hb-east" });
    expect(sent.slice(1).sort((a, b) => a.account!.localeCompare(b.account!))).toEqual([
      { account: "hb-nash", subset: "hb-east" },
      { account: "hb-stl", subset: "hb-east" },
    ]);
  });

  it("uses every reachable account for -", async () => {
    const { call, api } = await connect(splitRoute);
    const { res } = await call("searchlight_query_events", { organization: "-", fields: ["accountKey", "spend"], start: "2026-08-01", end: "2026-08-07" });
    expect(res.isError).toBeFalsy();
    expect(api().every((u) => u.pathname === "/api/-/events")).toBe(true);
    expect(api().slice(1).map((u) => u.searchParams.get("account")).sort()).toEqual(["hb-den", "hb-nash", "hb-stl", "ot-a", "ot-b", "solo"]);
  });
});

describe("searchlight_list_access", () => {
  it("lists each organization's subsets in text and structuredContent", async () => {
    const { call } = await connect(() => ({ body: [] }));
    const { res, text, structured } = await call("searchlight_list_access", {});
    expect(res.isError).toBeFalsy();
    expect(text).toContain('  - subset hb-east "East": 2 account(s): hb-stl, hb-nash');
    expect(text).toContain('  - subset hb-west "West": 1 account(s): hb-den');
    expect(structured.organizations[0].subsets).toEqual(WITH_SUBSETS.organizations[0]!.subsets);
  });

  it("is unchanged when no organization has subsets", async () => {
    const { call } = await connect(() => ({ body: [] }), NO_SUBSETS);
    const { text, structured } = await call("searchlight_list_access", {});
    expect(text).toBe(
      [
        "Signed in as me@example.com. 2 organization(s).",
        "",
        "- hb: 2 account(s): hb-stl, hb-nash",
        "- other: 1 account(s): ot-a",
        "",
        "Endpoints: ",
        "Dictionary: 5 fields (pass include_dictionary=true to list them, or use searchlight_list_fields).",
      ].join("\n"),
    );
    expect(structured.organizations).toEqual(NO_SUBSETS.organizations);
    expect(text).not.toMatch(/subset/);
  });
});

describe("pre-split by account x interval combinations", () => {
  function direct(access: AccessInfo) {
    const urls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      const body = url.pathname === "/api" ? access : [{ leads: 1 }];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const c = new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 8, timeoutMs: 5000, fetchImpl, sleep: async () => {} });
    const events = () => urls.filter((u) => u.pathname !== "/api");
    return { c, events };
  }
  const noop = async () => {};

  it("counts the subset's accounts, not the organization's", async () => {
    // 2 subset accounts x 400 days = 800 (one request); the 3-account organization would be 1,200.
    const { c, events } = direct(WITH_SUBSETS);
    const stats = await fetchEventsChunked(c, { organization: "hb", subset: "hb-east", fields: ["leads"], start: "2024-01-01", end: "2025-02-03", interval: "day" }, noop);
    expect(stats.notes).toBeUndefined();
    expect(events().map(params)).toEqual([{ fields: "leads", start: "2024-01-01", end: "2025-02-03", interval: "day", subset: "hb-east" }]);
  });

  it("splits by date on the subset's count and sends subset on every request", async () => {
    // 2 subset accounts x 600 days = 1,200.
    const { c, events } = direct(WITH_SUBSETS);
    const stats = await fetchEventsChunked(c, { organization: "hb", subset: "hb-east", fields: ["leads"], start: "2024-01-01", end: "2025-08-22", interval: "day" }, noop);
    expect(stats.notes?.[0]).toMatch(/1,200 account x interval combinations \(2 account\(s\) x 600 days\).*2 requests split by date/);
    expect(events()).toHaveLength(2);
    for (const u of events()) {
      expect(u.pathname).toBe("/api/hb/events");
      expect(u.searchParams.get("subset")).toBe("hb-east");
      expect(u.searchParams.get("account")).toBeNull();
    }
  });

  it("splits by account using only the subset's accounts", async () => {
    // A made-up subset of 1,001 accounts inside a 1,002-account organization: one month is already over 1,000.
    const members = Array.from({ length: 1001 }, (_, i) => `big-${i}`);
    const access: AccessInfo = {
      ...WITH_SUBSETS,
      organizations: [{ organization: "big", accounts: [...members, "big-outside"], subsets: [{ subset: "big-most", accounts: members }] }],
    };
    const { c, events } = direct(access);
    const stats = await fetchEventsChunked(
      c,
      { organization: "big", subset: "big-most", fields: ["accountKey", "leads"], start: "2026-01-01", end: "2026-02-28", interval: "month" },
      noop,
    );
    expect(stats.notes?.[0]).toMatch(/1001 account\(s\) x 2 months.*1001 requests split by account/);
    const sent = events();
    expect(sent).toHaveLength(1001);
    expect(sent.every((u) => u.searchParams.get("subset") === "big-most")).toBe(true);
    expect(new Set(sent.map((u) => u.searchParams.get("account")))).toEqual(new Set(members));
  });

  it("counts every reachable account for -", async () => {
    // 6 reachable accounts x 200 days = 1,200; assuming one account would be 200 and send one request.
    const { c, events } = direct(WITH_SUBSETS);
    const stats = await fetchEventsChunked(c, { organization: "-", fields: ["leads"], start: "2024-01-01", end: "2024-07-18", interval: "day" }, noop);
    expect(stats.notes?.[0]).toMatch(/1,200 account x interval combinations \(6 account\(s\) x 200 days\).*2 requests split by date/);
    expect(events()).toHaveLength(2);
    for (const u of events()) {
      expect(u.pathname).toBe("/api/-/events");
      expect(u.searchParams.get("subset")).toBeNull();
    }
  });
});
