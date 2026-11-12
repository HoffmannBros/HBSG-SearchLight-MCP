import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchLightClient, type AccessInfo } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import {
  MAX_OR_EXPANSION,
  allMetricsZero,
  equalityParam,
  gradingNote,
  qualifyingOrFilters,
  regexOrNotFilterFields,
  zeroTotalCheckApplies,
} from "../src/guards.js";
import { registerEventsTools } from "../src/tools/events.js";

// All rows are made up.

// ---- Pure functions ----

describe("gradingNote", () => {
  it("names the count metrics and says to request them separately when mixed with grading metrics", () => {
    const note = gradingNote(["leads", "customers", "gradedConversions"]);
    expect(note).toMatch(/^leads, customers were requested beside the grading metric gradedConversions\./);
    expect(note).toMatch(/reading high/);
    expect(note).toMatch(/Request leads, customers in a separate call/);
    expect(note).toMatch(/sent unchanged/);
  });

  it("is null for only grading metrics, only counts, or neither", () => {
    expect(gradingNote(["gradedConversions", "bookedConversions"])).toBeNull();
    expect(gradingNote(["leads", "customers"])).toBeNull();
    expect(gradingNote(["spend"])).toBeNull();
  });
});

describe("qualifyingOrFilters", () => {
  it("keeps top-level or filters of plain values, in order, from arrays or JSON strings", () => {
    expect(
      qualifyingOrFilters({
        attributionChannel: ["or", "Google Ads", "Google Lsa"],
        campaign: "Brand",
        businessUnit: '["or","HVAC","Plumbing"]',
        leads: ["or", 1, 2, true],
      }),
    ).toEqual([
      { field: "attributionChannel", values: ["Google Ads", "Google Lsa"] },
      { field: "businessUnit", values: ["HVAC", "Plumbing"] },
      { field: "leads", values: [1, 2, true] },
    ]);
  });

  it("skips nested arguments, other operators and an or with no values, and drops duplicate values", () => {
    expect(
      qualifyingOrFilters({
        a: ["or", "x", ["regex", "y"]],
        b: ["regex", "x"],
        c: ["not", "x"],
        d: ["or"],
        e: ["gte", 5],
      }),
    ).toEqual([]);
    expect(qualifyingOrFilters({ a: ["or", "x", "x", "y"] })).toEqual([{ field: "a", values: ["x", "y"] }]);
    expect(qualifyingOrFilters(undefined)).toEqual([]);
  });
});

describe("regexOrNotFilterFields", () => {
  it("finds regex or not anywhere in a per-field filter", () => {
    expect(
      regexOrNotFilterFields({ a: ["regex", "x"], b: ["not", "y"], c: ["or", "p", ["regex", "q"]], d: ["or", "p", "q"], e: "plain", f: '["regex","z"]' }),
    ).toEqual(["a", "b", "c", "f"]);
  });
});

describe("equalityParam", () => {
  it("sends strings as they are and numbers and booleans as JSON", () => {
    expect(equalityParam("Google Ads")).toBe("Google Ads");
    expect(equalityParam(3)).toBe("3");
    expect(equalityParam(false)).toBe("false");
  });
});

describe("zeroTotalCheckApplies and allMetricsZero", () => {
  it("applies only to interval=total, no dimensions, over 31 days", () => {
    expect(zeroTotalCheckApplies("total", [], 32)).toBe(true);
    expect(zeroTotalCheckApplies("total", [], 31)).toBe(false);
    expect(zeroTotalCheckApplies("total", ["accountKey"], 60)).toBe(false);
    expect(zeroTotalCheckApplies("month", [], 60)).toBe(false);
  });

  it("treats no rows, absent metrics and zeros as all zero", () => {
    expect(allMetricsZero([], ["leads"])).toBe(true);
    expect(allMetricsZero([{ leads: 0, spend: "0" }, {}], ["leads", "spend"])).toBe(true);
    expect(allMetricsZero([{ leads: 0, spend: 1 }], ["leads", "spend"])).toBe(false);
  });
});

// ---- Tools, against a fake fetch ----

const ACCESS: AccessInfo = {
  user: "me@example.com",
  organizations: [{ organization: "hb", accounts: ["hb-stl", "hb-nash"] }],
  endpoints: [],
  dictionary: {},
} as unknown as AccessInfo;

let client: Client | undefined;
let outDir = "";
beforeAll(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-repairs-"));
});
afterAll(async () => {
  await fs.rm(outDir, { recursive: true, force: true });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
});

type Route = (url: URL) => { status?: number; body: unknown };

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
  registerEventsTools(server, ctx);
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
  return { call, urls, api };
}

const params = (u: URL) => Object.fromEntries(u.searchParams.entries());

describe("grading warning (K4, note only)", () => {
  const base = { organization: "hb", account: "hb-stl", start: "2026-08-01", end: "2026-08-07" };

  it("sends a mixed request once, unchanged, with a note naming the count metrics", async () => {
    const { call, api, urls } = await connect(() => ({ body: [{ leads: 10, gradedConversions: 4 }] }));
    const { structured } = await call("searchlight_query_events", { ...base, fields: ["leads", "gradedConversions"] });
    expect(api().map(params)).toEqual([{ fields: "leads,gradedConversions", start: "2026-08-01", end: "2026-08-07", account: "hb-stl" }]);
    expect(structured.notes).toContainEqual(expect.stringMatching(/^leads was requested beside the grading metric gradedConversions\..*separate call/));
    expect(structured.apiCalls).toBe(urls.length);
  });

  it.each([[["gradedConversions", "bookedConversions"]], [["leads", "customers"]]])("adds no note for %j", async (fields) => {
    const { call, api } = await connect(() => ({ body: [{ [fields[0]!]: 1 }] }));
    const { structured } = await call("searchlight_query_events", { ...base, fields });
    expect(api()).toHaveLength(1);
    expect(structured.notes.some((n: string) => /grading metric/.test(n))).toBe(false);
  });
});

/** An or filter answers nothing; each equality answers its own rows. */
const orRoute: Route = (url) => {
  const ch = url.searchParams.get("attributionChannel");
  const withDim = url.searchParams.get("fields")!.startsWith("attributionChannel");
  if (ch === null || ch.startsWith("[")) return { body: [] };
  if (ch === "Google Ads") return { body: [{ ...(withDim ? { attributionChannel: "Google Ads" } : {}), leads: 7, spend: 100 }] };
  if (ch === "Google Lsa") return { body: [{ ...(withDim ? { attributionChannel: "Google Lsa" } : {}), leads: 2, spend: 20 }] };
  return { body: [] };
};

describe("or-filter fallback (K2)", () => {
  const base = {
    organization: "hb",
    account: "hb-stl",
    start: "2026-08-01",
    end: "2026-08-07",
    filters: { attributionChannel: ["or", "Google Ads", "Google Lsa"], businessUnit: "HVAC" },
  };

  it("re-sends once per value with an equality filter and concatenates the rows when the field is in fields", async () => {
    const { call, api, urls } = await connect(orRoute);
    const { structured, text } = await call("searchlight_query_events", { ...base, fields: ["attributionChannel", "leads"] });
    const sent = api().map(params);
    expect(sent).toEqual([
      { attributionChannel: '["or","Google Ads","Google Lsa"]', businessUnit: "HVAC", fields: "attributionChannel,leads", start: "2026-08-01", end: "2026-08-07", account: "hb-stl" },
      { attributionChannel: "Google Ads", businessUnit: "HVAC", fields: "attributionChannel,leads", start: "2026-08-01", end: "2026-08-07", account: "hb-stl" },
      { attributionChannel: "Google Lsa", businessUnit: "HVAC", fields: "attributionChannel,leads", start: "2026-08-01", end: "2026-08-07", account: "hb-stl" },
    ]);
    expect(structured.rows).toEqual([
      { attributionChannel: "Google Ads", leads: 7, spend: 100 },
      { attributionChannel: "Google Lsa", leads: 2, spend: 20 },
    ]);
    expect(text).toMatch(/known SearchLight fault/);
    expect(structured.notes).toContainEqual(expect.stringMatching(/2 extra request\(s\), "Google Ads" 1 row\(s\), "Google Lsa" 1 row\(s\); 2 row\(s\) in all\..*rates and averages are per value/));
    expect(structured.apiCalls).toBe(urls.length);
    expect(structured.apiCalls).toBe(4); // /api for the scope, the or request, two retries
  });

  it("adds the field to fields for the retries when it was not requested, and says so", async () => {
    const { call, api } = await connect(orRoute);
    const { structured, text } = await call("searchlight_query_events", { ...base, fields: ["leads"] });
    const sent = api().map(params);
    expect(sent.map((p) => p.fields)).toEqual(["leads", "attributionChannel,leads", "attributionChannel,leads"]);
    expect(sent.slice(1).map((p) => p.attributionChannel)).toEqual(["Google Ads", "Google Lsa"]);
    expect(structured.rows.map((r: any) => r.attributionChannel)).toEqual(["Google Ads", "Google Lsa"]);
    expect(structured.notes).toContainEqual(expect.stringMatching(/attributionChannel was not in fields, so it was added/));
    expect(text).toMatch(/\| attributionChannel \| leads \|/);
  });

  it("returns a non-empty or result as is, with no extra requests", async () => {
    const { call, api } = await connect(() => ({ body: [{ attributionChannel: "Google Ads", leads: 9 }] }));
    const { structured } = await call("searchlight_query_events", { ...base, fields: ["attributionChannel", "leads"] });
    expect(api()).toHaveLength(1);
    expect(structured.rows).toEqual([{ attributionChannel: "Google Ads", leads: 9 }]);
    expect(structured.notes.some((n: string) => /fault/.test(n))).toBe(false);
  });

  it(`does not retry above ${MAX_OR_EXPANSION} values, and says why`, async () => {
    const { call, api } = await connect(orRoute);
    const many = Array.from({ length: MAX_OR_EXPANSION + 1 }, (_, i) => `c${i}`);
    const { structured } = await call("searchlight_query_events", { ...base, filters: { attributionChannel: ["or", ...many] }, fields: ["leads"] });
    expect(api()).toHaveLength(1);
    expect(structured.notes).toContainEqual(expect.stringMatching(/has 13 values, over the 12 this tool will retry/));
  });

  it("expands exactly 12 values", async () => {
    const { call, api } = await connect(orRoute);
    const twelve = Array.from({ length: MAX_OR_EXPANSION }, (_, i) => `c${i}`);
    await call("searchlight_query_events", { ...base, filters: { attributionChannel: ["or", ...twelve] }, fields: ["attributionChannel", "leads"] });
    expect(api()).toHaveLength(1 + MAX_OR_EXPANSION);
  });

  it("does not retry with retry_or_filters=false, and says so", async () => {
    const { call, api } = await connect(orRoute);
    const { structured } = await call("searchlight_query_events", { ...base, fields: ["leads"], retry_or_filters: false });
    expect(api()).toHaveLength(1);
    expect(structured.notes).toContainEqual(expect.stringMatching(/Not retried because retry_or_filters=false/));
  });

  it("expands only the first qualifying filter and names the rest", async () => {
    const { call, api } = await connect(() => ({ body: [] }));
    const { structured } = await call("searchlight_query_events", {
      ...base,
      filters: { attributionChannel: ["or", "Google Ads", "Google Lsa"], campaign: ["or", "A", "B"] },
      fields: ["attributionChannel", "leads"],
    });
    const sent = api().map(params);
    expect(sent).toHaveLength(3);
    expect(sent.slice(1).map((p) => [p.attributionChannel, p.campaign])).toEqual([
      ["Google Ads", '["or","A","B"]'],
      ["Google Lsa", '["or","A","B"]'],
    ]);
    expect(structured.notes).toContainEqual(expect.stringMatching(/the or filter on campaign was sent as given/));
  });

  it("does not retry an empty regex or not filter, and suggests equality filters", async () => {
    const { call, api } = await connect(() => ({ body: [] }));
    const { structured } = await call("searchlight_query_events", { ...base, filters: { campaign: ["regex", "brand"] }, fields: ["leads"] });
    expect(api()).toHaveLength(1);
    expect(structured.notes).toContainEqual(expect.stringMatching(/filter on campaign uses regex or not.*plain equality filters/));
  });

  it("leaves spendReconciliation out when the retries replace the result", async () => {
    const { call, api } = await connect(orRoute);
    const { structured } = await call("searchlight_query_events", { ...base, fields: ["attributionChannel", "spend"] });
    // main, unsplit spend, then one per value
    expect(api().map((u) => u.searchParams.get("fields"))).toEqual(["attributionChannel,spend", "spend", "attributionChannel,spend", "attributionChannel,spend"]);
    expect(structured.spendReconciliation).toBeUndefined();
    expect(structured.notes).toContainEqual(expect.stringMatching(/spend check was not repeated/));
  });

  it("works in the CSV export too", async () => {
    const { call, api } = await connect(orRoute);
    const { structured } = await call("searchlight_export_events_csv", { ...base, fields: ["leads"], filename: "or-fallback" });
    expect(api()).toHaveLength(3);
    expect(structured.rows).toBe(2);
    // The file's columns are fixed when it is opened, so the added field follows the requested ones.
    expect(structured.columns).toEqual(["leads", "attributionChannel", "spend"]);
    expect(structured.apiCalls).toBe(4); // includes /api for the scope
  });
});

describe("zero-total cross-check (K9)", () => {
  const base = { organization: "hb", account: "hb-stl", fields: ["leads", "spend"], start: "2026-08-01", end: "2026-09-29" };
  /** The total reads zero; the months do not. */
  const failing: Route = (url) =>
    url.searchParams.get("interval") === "month"
      ? { body: [{ start: "2026-08-01", end: "2026-08-31", leads: 5, spend: 50 }, { start: "2026-09-01", end: "2026-09-29", leads: 3, spend: 30 }] }
      : { body: [{ leads: 0, spend: 0 }] };

  it("returns an error with the monthly rows when the total reads zero and the months do not", async () => {
    const { call, api, urls } = await connect(failing);
    const { res, structured, text } = await call("searchlight_query_events", base);
    expect(res.isError).toBe(true);
    expect(api().map(params)).toEqual([
      { fields: "leads,spend", start: "2026-08-01", end: "2026-09-29", account: "hb-stl" },
      { fields: "leads,spend", start: "2026-08-01", end: "2026-09-29", account: "hb-stl", interval: "month" },
    ]);
    expect(text).toMatch(/^The interval=total read failed/);
    expect(text).toMatch(/do not add them up except spend/);
    expect(structured.error).toBe("zero-total-read-failed");
    expect(structured.monthlyRows).toHaveLength(2);
    expect(structured.apiCalls).toBe(urls.length);
  });

  it("notes the extra request when the months are zero too", async () => {
    const { call, api } = await connect((url) => ({ body: url.searchParams.get("interval") === "month" ? [] : [{ leads: 0, spend: 0 }] }));
    const { res, structured } = await call("searchlight_query_events", base);
    expect(res.isError).toBeFalsy();
    expect(api()).toHaveLength(2);
    expect(structured.notes).toContainEqual(expect.stringMatching(/monthly rows are also zero.*check_zero_total=false/));
  });

  it.each([
    ["31 days or less", { end: "2026-08-31" }],
    ["a dimension", { fields: ["accountKey", "leads", "spend"] }],
    ["an interval", { interval: "month" }],
    ["check_zero_total=false", { check_zero_total: false }],
  ])("does not fire with %s", async (_label, extra) => {
    const { call, api } = await connect(failing);
    const { res } = await call("searchlight_query_events", { ...base, ...extra });
    expect(res.isError).toBeFalsy();
    expect(api()).toHaveLength(1);
  });

  it("does not fire when any metric is non-zero", async () => {
    const { call, api } = await connect(() => ({ body: [{ leads: 0, spend: 12 }] }));
    await call("searchlight_query_events", base);
    expect(api()).toHaveLength(1);
  });

  it("discards the export file and returns the error", async () => {
    const { call } = await connect(failing);
    const { res, structured } = await call("searchlight_export_events_csv", { ...base, filename: "zero-total" });
    expect(res.isError).toBe(true);
    expect(structured.monthlyRows).toHaveLength(2);
    const files = await fs.readdir(outDir);
    expect(files.some((f) => f.startsWith("zero-total"))).toBe(false);
  });
});
