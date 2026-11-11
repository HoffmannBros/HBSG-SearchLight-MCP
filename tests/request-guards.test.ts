import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PreflightError, SearchLightApiError, SearchLightClient } from "../src/client.js";
import { fetchEventsChunked, planEventsTasks } from "../src/chunking.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import type { Row } from "../src/csv.js";
import { combinationsViolation } from "../src/dates.js";
import { FilterError, filtersToParams } from "../src/filters.js";
import { registerEventsTools } from "../src/tools/events.js";
import { registerRawTools } from "../src/tools/raw.js";

// Made-up organization and accounts; no live data.
const FOUR = ["k1", "k2", "k3", "k4"];
const ACCESS = {
  user: "me@example.com",
  organizations: [{ organization: "acme", accounts: FOUR }],
  endpoints: [],
  dictionary: { leads: { type: "metric" }, spend: { type: "metric" }, attributionChannel: { type: "dimension" } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake API: /api answers ACCESS; events answers `route` (default: one row echoing the window). */
function fakeFetch(route?: (url: URL) => Response) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname === "/api") return jsonResponse(ACCESS);
    if (route) return route(url);
    const p = url.searchParams;
    return jsonResponse([{ start: p.get("start"), end: p.get("end"), account: p.get("account"), leads: 1 }]);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, events: () => urls.filter((u) => u.pathname !== "/api") };
}

function makeClient(fetchImpl: typeof fetch) {
  return new SearchLightClient({ apiKey: "sl_test", baseUrl: "https://example.test", concurrency: 4, timeoutMs: 5000, fetchImpl, sleep: async () => {} });
}

/** Query string of an events URL as sorted key=value pairs, for exact assertions. */
function query(url: URL): Record<string, string> {
  return Object.fromEntries([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

async function connect(route?: (url: URL) => Response) {
  const fake = fakeFetch(route);
  const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_BASE_URL: "https://example.test" });
  const ctx: AppContext = { config, client: makeClient(fake.fetchImpl) };
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerEventsTools(server, ctx);
  registerRawTools(server, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: "t", version: "0" });
  await mcp.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp!.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    return { res, text, structured: res.structuredContent as Record<string, any> };
  };
  return { call, ...fake };
}

describe("filter shape (K3)", () => {
  it("refuses a plain list and shows the or form", () => {
    expect(() => filtersToParams({ attributionChannel: ["Google Ads", "Bing"] })).toThrow(FilterError);
    expect(() => filtersToParams({ attributionChannel: ["Google Ads", "Bing"] })).toThrow('attributionChannel=["or","Google Ads","Bing"]');
  });

  it("refuses object values and translates them to the operator form", () => {
    const cases: Array<[unknown, string]> = [
      [{ in: ["A", "B"] }, '["or","A","B"]'],
      [{ $in: ["A", "B"] }, '["or","A","B"]'],
      [{ $gt: 0 }, '["gt",0]'],
      [{ $gte: 10, $lte: 20 }, '["and",["gte",10],["lte",20]]'],
      [{ $regex: "gmb|gbp" }, '["regex","gmb|gbp"]'],
      [{ $ne: "Organic" }, '["not","Organic"]'],
      [{ $nin: ["A", "B"] }, '["not",["or","A","B"]]'],
    ];
    for (const [value, fix] of cases) {
      expect(() => filtersToParams({ campaign: value as never })).toThrow(`campaign=${fix}`);
    }
  });

  it("falls back to a generic example when there is no sensible translation", () => {
    expect(() => filtersToParams({ campaign: { foo: "bar" } })).toThrow('campaign=["or", "A", "B"]');
  });

  it("refuses a bad expression nested inside a valid one", () => {
    expect(() => filtersToParams({ adjustedType: ["not", ["estimated", "sold"]] })).toThrow('adjustedType=["not",["or","estimated","sold"]]');
    expect(() => filtersToParams({ total: ["and", { $gte: 100 }, ["lte", 500]] })).toThrow('total=["and",["gte",100],["lte",500]]');
    expect(() => filtersToParams({ campaign: [] })).toThrow(FilterError);
    expect(() => filtersToParams({ campaign: ["OR", "a", "b"] })).toThrow('campaign=["or","a","b"]');
  });

  it("refuses a JSON string holding a plain list, since the API parses it as JSON", () => {
    expect(() => filtersToParams({ attributionChannel: '["Google Ads","Bing"]' })).toThrow('["or","Google Ads","Bing"]');
  });

  it("passes every documented operator form, nested ones included, encoded exactly as before", () => {
    const filters = {
      attributionCategory: ["or", "Organic", "Advertising"],
      total: ["and", ["gte", 100], ["lte", 500]],
      adjustedType: ["not", ["or", "estimated", "sold", "closed"]],
      attributionKeywords: ["empty"],
      attributionSource: ["notEmpty"],
      campaign: ["regex", "gmb|gbp", "ui"],
      revenue: ["gt", 1000],
      soldRevenue: ["gte", 1000],
      closedRevenue: ["lt", 5],
      opportunityStartDate: ["lte", "2026-05-01"],
      type: "closed",
      typeIsLast: true,
      jobs: 3,
      conversionChannel: '["or","Phone","Form"]',
      notJson: "[not json",
    };
    expect(filtersToParams(filters, ["or", { attributionCategory: "Advertising" }, { total: ["gte", 50000] }])).toEqual({
      attributionCategory: '["or","Organic","Advertising"]',
      total: '["and",["gte",100],["lte",500]]',
      adjustedType: '["not",["or","estimated","sold","closed"]]',
      attributionKeywords: '["empty"]',
      attributionSource: '["notEmpty"]',
      campaign: '["regex","gmb|gbp","ui"]',
      revenue: '["gt",1000]',
      soldRevenue: '["gte",1000]',
      closedRevenue: '["lt",5]',
      opportunityStartDate: '["lte","2026-05-01"]',
      type: "closed",
      typeIsLast: "true",
      jobs: "3",
      conversionChannel: '["or","Phone","Form"]',
      notJson: "[not json",
      filter: '["or",{"attributionCategory":"Advertising"},{"total":["gte",50000]}]',
    });
  });

  it("query_events refuses a plain-list filter with no request sent", async () => {
    const { call, urls } = await connect();
    const { res, text } = await call("searchlight_query_events", {
      organization: "acme",
      fields: ["attributionChannel", "leads"],
      start: "2026-10-01",
      end: "2026-10-07",
      filters: { attributionChannel: ["Google Ads", "Bing"] },
    });
    expect(res.isError).toBe(true);
    expect(text).toContain('attributionChannel=["or","Google Ads","Bing"]');
    expect(text).toContain("Not sent");
    expect(urls).toHaveLength(0);
  });

  it("query_events refuses an object filter with no request sent", async () => {
    const { call, urls } = await connect();
    const { res, text } = await call("searchlight_query_events", {
      organization: "acme",
      fields: ["attributionChannel", "leads"],
      start: "2026-10-01",
      end: "2026-10-07",
      filters: { attributionChannel: { in: ["Google Ads", "Bing"] } },
    });
    expect(res.isError).toBe(true);
    expect(text).toContain('attributionChannel=["or","Google Ads","Bing"]');
    expect(urls).toHaveLength(0);
  });

  it("api_call refuses a plain-list or object filter on events with no request sent", async () => {
    const { call, urls } = await connect();
    for (const value of ['["Google Ads","Bing"]', '{"$gt":0}']) {
      const { res, text } = await call("searchlight_api_call", {
        path: "/api/acme/events",
        params: { fields: "leads", start: "2026-10-01", end: "2026-10-07", attributionChannel: value },
      });
      expect(res.isError).toBe(true);
      expect(text).toMatch(/attributionChannel=\[/);
    }
    expect(urls).toHaveLength(0);
  });

  it("api_call still sends a valid operator filter and a cross-field filter, with the exact query", async () => {
    const { call, events } = await connect();
    const { res } = await call("searchlight_api_call", {
      path: "/api/acme/events",
      params: {
        fields: "attributionChannel,leads",
        start: "2026-10-01",
        end: "2026-10-07",
        account: "k1",
        attributionChannel: '["or","Google Ads","Bing"]',
        filter: '["or",{"attributionCategory":"Advertising"},{"total":["gte",50000]}]',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.pathname).toBe("/api/acme/events");
    expect(query(events()[0]!)).toEqual({
      account: "k1",
      attributionChannel: '["or","Google Ads","Bing"]',
      end: "2026-10-07",
      fields: "attributionChannel,leads",
      filter: '["or",{"attributionCategory":"Advertising"},{"total":["gte",50000]}]',
      start: "2026-10-01",
    });
  });
});

describe("size codes (K10)", () => {
  const err = (code: string | undefined, message: string) => new SearchLightApiError(400, message, code, "", "u");

  it("treats the three size codes as size limits, whatever the message says", () => {
    for (const code of ["too-many-combinations", "response-too-large", "too-many-documents"]) {
      expect(err(code, "x").isSizeLimit()).toBe(true);
    }
  });

  it("keeps range-too-long out of the size limits", () => {
    const e = err("range-too-long", "Range exceeds the 90-day attribution window; reduce it or add an interval");
    expect(e.isSizeLimit()).toBe(false);
    expect(e.isAttributionWindow()).toBe(true);
  });

  it("splits and retries on too-many-combinations from the API", async () => {
    // A cap the local count does not know about (the API is stricter than 1,000):
    // the adaptive splitter must still handle the code.
    const { fetchImpl, events } = fakeFetch((url) => {
      const p = url.searchParams;
      if (p.get("start") === "2026-01-01" && p.get("end") === "2026-01-31") {
        return jsonResponse({ error: "This request would query 124 account×interval combinations", code: "too-many-combinations" }, 400);
      }
      return jsonResponse([{ start: p.get("start"), leads: 1 }]);
    });
    const stats = await fetchEventsChunked(
      makeClient(fetchImpl),
      { organization: "acme", fields: ["leads"], start: "2026-01-01", end: "2026-01-31", interval: "day", accounts: FOUR },
      async () => {},
    );
    expect(stats).toEqual({ chunks: 2, splits: 1 });
    expect(events().map((u) => `${u.searchParams.get("start")}..${u.searchParams.get("end")}`)).toEqual([
      "2026-01-01..2026-01-31",
      "2026-01-01..2026-01-16",
      "2026-01-17..2026-01-31",
    ]);
  });
});

describe("pre-split on combinations (K10)", () => {
  it("sends a request at exactly 1,000 combinations as one request with the exact query", async () => {
    // 4 accounts x 250 days (2025-09-01..2026-05-08) = 1,000: accepted live.
    const { fetchImpl, events } = fakeFetch();
    const stats = await fetchEventsChunked(
      makeClient(fetchImpl),
      { organization: "acme", fields: ["leads"], start: "2025-09-01", end: "2026-05-08", interval: "day" },
      async () => {},
    );
    expect(stats).toEqual({ chunks: 1, splits: 0 });
    expect(stats.notes).toBeUndefined();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.pathname).toBe("/api/acme/events");
    expect(query(events()[0]!)).toEqual({ end: "2026-05-08", fields: "leads", interval: "day", start: "2025-09-01" });
  });

  it("pre-splits by date when the organization's accounts push it over 1,000", async () => {
    // 4 accounts x 300 days = 1,200: refused live with too-many-combinations.
    const { fetchImpl, events } = fakeFetch();
    const rows: Row[] = [];
    const stats = await fetchEventsChunked(
      makeClient(fetchImpl),
      { organization: "acme", fields: ["leads"], start: "2025-09-01", end: "2026-06-27", interval: "day" },
      async (r) => {
        rows.push(...r);
      },
    );
    expect(stats.chunks).toBe(2);
    expect(stats.splits).toBe(0);
    expect(stats.notes?.[0]).toMatch(/1,200 account x interval combinations \(4 account\(s\) x 300 days\).*2 requests split by date/);
    const sent = events().map(query).sort((a, b) => a.start!.localeCompare(b.start!));
    expect(sent).toEqual([
      { end: "2026-01-28", fields: "leads", interval: "day", start: "2025-09-01" },
      { end: "2026-06-27", fields: "leads", interval: "day", start: "2026-01-29" },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("pre-splits with an explicit account list and keeps it on every request", async () => {
    // 2 accounts x 501 days = 1,002: refused live.
    const { fetchImpl, events, urls } = fakeFetch();
    const stats = await fetchEventsChunked(
      makeClient(fetchImpl),
      { organization: "acme", fields: ["leads"], start: "2025-01-01", end: "2026-05-16", interval: "day", accounts: ["k1", "k2"] },
      async () => {},
    );
    expect(stats.chunks).toBe(2);
    expect(urls.filter((u) => u.pathname === "/api")).toHaveLength(0);
    const sent = events().map(query).sort((a, b) => a.start!.localeCompare(b.start!));
    expect(sent).toEqual([
      { accounts: "k1,k2", end: "2025-09-08", fields: "leads", interval: "day", start: "2025-01-01" },
      { accounts: "k1,k2", end: "2026-05-16", fields: "leads", interval: "day", start: "2025-09-09" },
    ]);
  });

  it("cuts month windows at month boundaries", () => {
    // 4 accounts x 255 months = 1,020: refused live, and the API's count matched ours.
    const plan = planEventsTasks(
      { organization: "acme", fields: ["leads"], start: "2004-06-15", end: "2025-08-10", interval: "month" },
      FOUR,
    );
    expect(plan.tasks.map((t) => t.window)).toEqual([
      { start: "2004-06-15", end: "2015-01-31" },
      { start: "2015-02-01", end: "2025-08-10" },
    ]);
    expect(plan.note).toMatch(/1,020/);
  });

  it("pre-splits by account when there are more than 1,000 accounts and rows carry the account", () => {
    const many = Array.from({ length: 1001 }, (_, i) => `a${i}`);
    const plan = planEventsTasks(
      { organization: "acme", fields: ["accountKey", "leads"], start: "2026-10-01", end: "2026-10-31", interval: "total", accounts: many },
      many,
    );
    expect(plan.tasks).toHaveLength(1001);
    expect(plan.tasks[0]).toEqual({ accounts: ["a0"], window: { start: "2026-10-01", end: "2026-10-31" } });
    expect(plan.note).toMatch(/split by account/);
  });

  it("refuses locally, with zero requests, when it cannot be split without changing the rows", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `a${i}`);
    const { fetchImpl, urls } = fakeFetch();
    const err = await fetchEventsChunked(
      makeClient(fetchImpl),
      { organization: "acme", fields: ["leads"], start: "2026-10-01", end: "2026-10-31", interval: "total", accounts: many },
      async () => {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreflightError);
    const message = (err as Error).message;
    expect(message).toContain("1,001 account x interval combinations");
    expect(message).toMatch(/fewer accounts, a coarser interval, or a shorter range/);
    expect(message).toContain("Not sent");
    expect(urls).toHaveLength(0);
  });

  it("query_events reports the pre-split in notes and counts every request in apiCalls", async () => {
    const { call, events } = await connect();
    const { res, structured } = await call("searchlight_query_events", {
      organization: "acme",
      fields: ["leads"],
      start: "2025-09-01",
      end: "2026-06-27",
      interval: "day",
    });
    expect(res.isError).toBeFalsy();
    expect(events()).toHaveLength(2);
    expect(structured.apiCalls).toBe(3); // /api plus two events requests
    expect(structured.notes.join(" ")).toMatch(/2 requests split by date/);
  });
});

describe("combinations check on a single call (api_call)", () => {
  it("refuses an explicit account list over 1,000 combinations, and allows exactly 1,000", () => {
    expect(combinationsViolation({ start: "2025-01-01", end: "2026-05-16", interval: "day", accounts: "k1,k2" })).toMatch(/1,002/);
    expect(combinationsViolation({ start: "2025-01-01", end: "2026-05-15", interval: "day", accounts: "k1,k2" })).toBeNull();
    expect(combinationsViolation({ start: "2025-01-01", end: "2026-05-16", interval: "day" })).toBeNull();
  });

  it("api_call refuses it with no request sent", async () => {
    const { call, urls } = await connect();
    const { res, text } = await call("searchlight_api_call", {
      path: "/api/acme/events",
      params: { fields: "leads", start: "2025-01-01", end: "2026-05-16", interval: "day", accounts: "k1,k2" },
    });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/1,002 account x interval combinations/);
    expect(urls).toHaveLength(0);
  });
});
