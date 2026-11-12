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
  NO_TRACKED_EVENTS,
  RowGuard,
  addPercentagePoints,
  columnsWithPoints,
  crossPeriodNote,
  filterFieldNames,
  percentagePointsNote,
  periodLengthNote,
  reconcileSpend,
  recordGrainNotes,
  spendReconciliationFields,
  spendReconciliationNote,
  summingNote,
  unattributedSpendRows,
  type RowGuardOptions,
} from "../src/guards.js";
import { registerCompareTools } from "../src/tools/compare.js";
import { registerEventsTools } from "../src/tools/events.js";

// All rows are made up.

// ---- Pure functions ----

describe("spendReconciliationFields", () => {
  it("asks for the account dimensions plus spend when spend is split by another dimension at interval=total", () => {
    expect(spendReconciliationFields(["accountKey", "campaign"], ["spend", "leads"], "total")).toEqual(["accountKey", "spend"]);
    expect(spendReconciliationFields(["account", "accountKey", "campaign"], ["spend"], "total")).toEqual(["accountKey", "account", "spend"]);
    expect(spendReconciliationFields(["attributionChannel"], ["spend"], "total")).toEqual(["spend"]);
  });

  it("skips when there is no splitting dimension, no spend, an interval, or record grain", () => {
    expect(spendReconciliationFields([], ["spend"], "total")).toBeNull();
    expect(spendReconciliationFields(["accountKey", "account"], ["spend"], "total")).toBeNull();
    expect(spendReconciliationFields(["date"], ["spend"], "total")).toBeNull();
    expect(spendReconciliationFields(["campaign"], ["leads"], "total")).toBeNull();
    expect(spendReconciliationFields(["campaign"], ["spend"], "month")).toBeNull();
    expect(spendReconciliationFields(["campaign", "opportunityId"], ["spend"], "total")).toBeNull();
  });
});

describe("reconcileSpend", () => {
  it("reports the shortfall in all and per account, rounded to cents", () => {
    const split = [
      { accountKey: "a", campaign: "x", spend: 100.1 },
      { accountKey: "a", campaign: "y", spend: 0.2 },
      { accountKey: "b", campaign: "x", spend: 50 },
    ];
    const unsplit = [
      { accountKey: "a", spend: 110.3 },
      { accountKey: "b", spend: 50 },
    ];
    const rec = reconcileSpend(split, unsplit, ["accountKey"]);
    expect(rec).toEqual({
      total: 160.3,
      inRows: 150.3,
      missing: 10,
      byAccount: [
        { accountKey: "a", total: 110.3, inRows: 100.3, missing: 10 },
        { accountKey: "b", total: 50, inRows: 50, missing: 0 },
      ],
    });
    const note = spendReconciliationNote(rec);
    expect(note).toMatch(/Spend on combinations with no tracked events: \$10\.00 of \$160\.30/);
    expect(note).toMatch(/By account: a \$10\.00 of \$110\.30\./);
    expect(note).not.toMatch(/\bb \$/);
  });

  it("has no byAccount without account dimensions, and says the check passed when nothing is missing", () => {
    const rec = reconcileSpend([{ campaign: "x", spend: 5 }], [{ spend: 5 }], []);
    expect(rec).toEqual({ total: 5, inRows: 5, missing: 0 });
    expect(spendReconciliationNote(rec)).toMatch(/^Spend check: 1 extra request/);
  });
});

describe("unattributedSpendRows", () => {
  it("builds one row per short account with the other dimensions marked", () => {
    const rec = reconcileSpend(
      [{ accountKey: "a", account: "A", campaign: "x", spend: 1 }],
      [
        { accountKey: "a", account: "A", spend: 3 },
        { accountKey: "b", account: "B", spend: 2 },
      ],
      ["accountKey", "account"],
    );
    expect(unattributedSpendRows(rec, ["accountKey", "account", "campaign", "attributionChannel"])).toEqual([
      { accountKey: "a", account: "A", campaign: NO_TRACKED_EVENTS, attributionChannel: NO_TRACKED_EVENTS, spend: 2 },
      { accountKey: "b", account: "B", campaign: NO_TRACKED_EVENTS, attributionChannel: NO_TRACKED_EVENTS, spend: 2 },
    ]);
  });

  it("builds a single row without account dimensions, and none when nothing is missing", () => {
    expect(unattributedSpendRows(reconcileSpend([{ campaign: "x", spend: 1 }], [{ spend: 4 }], []), ["campaign"])).toEqual([
      { campaign: NO_TRACKED_EVENTS, spend: 3 },
    ]);
    expect(unattributedSpendRows(reconcileSpend([{ campaign: "x", spend: 4 }], [{ spend: 4 }], []), ["campaign"])).toEqual([]);
  });
});

describe("summingNote", () => {
  it("names every requested metric except spend when there is an interval", () => {
    const note = summingNote(["leads", "spend", "soldRevenue"], "month");
    expect(note).toMatch(/^Do not add up leads, soldRevenue across the month rows/);
    expect(note).toMatch(/Only spend sums exactly/);
    expect(note).toMatch(/90 days or less; over 90 days there is no exact total/);
  });

  it("is absent at interval=total and when only spend is requested", () => {
    expect(summingNote(["leads"], "total")).toBeNull();
    expect(summingNote(["spend"], "week")).toBeNull();
  });
});

describe("recordGrainNotes", () => {
  it("names the metrics that mean nothing at record grain, and adds the dedupe note for opportunityId", () => {
    const notes = recordGrainNotes(["opportunityId", "campaign"], ["leads", "bookRate", "spend"]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^opportunityId switches the rows to about one per opportunity, where bookRate, spend are not meaningful/);
    expect(notes[1]).toMatch(/Dedupe on opportunityId/);
  });

  it("gives only the metric note for other record-grain dimensions, and nothing otherwise", () => {
    expect(recordGrainNotes(["sourceId"], ["roasClosed"])).toEqual([expect.stringMatching(/roasClosed is not meaningful/)]);
    expect(recordGrainNotes(["sourceId"], ["leads"])).toEqual([]);
    expect(recordGrainNotes(["campaign"], ["bookRate"])).toEqual([]);
  });
});

describe("compare_periods helpers", () => {
  it("adds m_points as 100 times the change for rate metrics only", () => {
    const rows: Record<string, unknown>[] = [
      { bookRate_change: 0.05, leads_change: 3 },
      { bookRate_change: null, leads_change: null },
    ];
    expect(addPercentagePoints(rows, ["bookRate", "leads"])).toEqual(["bookRate"]);
    expect(rows[0]!.bookRate_points).toBe(5);
    expect(rows[1]!.bookRate_points).toBeNull();
    expect("leads_points" in rows[0]!).toBe(false);
    expect(columnsWithPoints(["campaign", "bookRate", "bookRate_pct", "leads_pct"], ["bookRate"])).toEqual([
      "campaign",
      "bookRate",
      "bookRate_pct",
      "bookRate_points",
      "leads_pct",
    ]);
  });

  it("notes relative change versus points, cross-period revenue, and unequal lengths only when they apply", () => {
    expect(percentagePointsNote(["bookRate"])).toMatch(/m_pct is the relative change .* m_points is the change in percentage points/);
    expect(percentagePointsNote([])).toBeNull();
    expect(crossPeriodNote(["soldRevenue", "leads", "payingCustomers"])).toMatch(/^soldRevenue, payingCustomers: a job sold in the earlier period and closed in the later one appears in both/);
    expect(crossPeriodNote(["closedRevenue", "leads"])).toBeNull();
    expect(periodLengthNote(31, 30)).toMatch(/current period is 31 days and the comparison period is 30 days/);
    expect(periodLengthNote(30, 30)).toBeNull();
  });
});

describe("RowGuard", () => {
  const opts = (over: Partial<RowGuardOptions> = {}): RowGuardOptions => ({
    dimensions: ["campaign"],
    metrics: ["leads", "spend"],
    interval: "total",
    start: "2026-08-01",
    end: "2026-08-31",
    dropPlaceholders: true,
    filterFields: [],
    ...over,
  });

  it("drops a row only when every dimension is blank and every metric is 0 or absent", () => {
    const guard = new RowGuard(opts());
    const kept = guard.accept([
      { leads: 0, spend: 0 },
      { campaign: "", leads: 0 },
      { campaign: "N/A", leads: 0, spend: 0 },
      { campaign: null, leads: 2, spend: 0 },
      { leads: 0, spend: 12.5 },
      { campaign: "x", leads: 0, spend: 0 },
    ]);
    expect(kept).toEqual([{ campaign: null, leads: 2, spend: 0 }, { leads: 0, spend: 12.5 }, { campaign: "x", leads: 0, spend: 0 }]);
    expect(guard.notes()).toEqual([expect.stringMatching(/^Dropped 3 placeholder row\(s\)/)]);
  });

  it("keeps placeholder rows when asked, and never treats a dimensionless total as one", () => {
    const keep = new RowGuard(opts({ dropPlaceholders: false }));
    expect(keep.accept([{ leads: 0, spend: 0 }])).toHaveLength(1);
    expect(keep.notes()).toEqual([]);
    const total = new RowGuard(opts({ dimensions: [] }));
    expect(total.accept([{ leads: 0, spend: 0 }])).toHaveLength(1);
  });

  it("lists interval buckets with no rows", () => {
    const guard = new RowGuard(opts({ dimensions: [], metrics: ["leads"], interval: "month", start: "2026-05-01", end: "2026-08-31" }));
    guard.accept([
      { start: "2026-05-01", end: "2026-05-31", leads: 3 },
      { start: "2026-07-01", end: "2026-07-31", leads: 1 },
    ]);
    expect(guard.notes()).toEqual([expect.stringMatching(/^No rows for 2 of 4 month bucket\(s\), starting 2026-06-01, 2026-08-01\. .* mean zero activity/)]);
  });

  it("counts dimension values missing from some buckets, and is quiet when every bucket is present", () => {
    const guard = new RowGuard(opts({ interval: "month", start: "2026-05-01", end: "2026-06-30" }));
    guard.accept([
      { start: "2026-05-01", campaign: "x", leads: 1 },
      { start: "2026-06-01", campaign: "x", leads: 1 },
      { start: "2026-06-01", campaign: "y", leads: 1 },
    ]);
    expect(guard.notes()).toEqual([expect.stringMatching(/^1 of 2 campaign value\(s\) have no row in some month buckets/)]);
    const full = new RowGuard(opts({ interval: "month", start: "2026-05-01", end: "2026-06-30" }));
    full.accept([
      { start: "2026-05-01", campaign: "x", leads: 1 },
      { start: "2026-06-01", campaign: "x", leads: 1 },
    ]);
    expect(full.notes()).toEqual([]);
    const totals = new RowGuard(opts());
    totals.accept([{ campaign: "x", leads: 1 }]);
    expect(totals.notes()).toEqual([]);
  });

  it("explains an empty result filtered on customerPhone, and only then", () => {
    const phone = new RowGuard(opts({ filterFields: ["customerPhone"] }));
    phone.accept([]);
    expect(phone.notes()).toEqual([expect.stringMatching(/customerPhone is redacted.*customerName or customerEmail/)]);
    const other = new RowGuard(opts({ filterFields: ["campaign"] }));
    other.accept([]);
    expect(other.notes()).toEqual([]);
    const nonEmpty = new RowGuard(opts({ filterFields: ["customerPhone"] }));
    nonEmpty.accept([{ campaign: "x", leads: 1 }]);
    expect(nonEmpty.notes()).toEqual([]);
  });

  it("counts zero-spend rows when ROAS is requested with a dimension and spend", () => {
    const guard = new RowGuard(opts({ metrics: ["roasClosed", "spend"] }));
    guard.accept([
      { campaign: "x", roasClosed: 4, spend: 10 },
      { campaign: "y", roasClosed: 0, spend: 0 },
    ]);
    expect(guard.notes()).toEqual([expect.stringMatching(/^1 of 2 row\(s\) have zero spend; roasClosed is not meaningful there/)]);
    const noSpend = new RowGuard(opts({ metrics: ["roasClosed"] }));
    noSpend.accept([{ campaign: "y", roasClosed: 0 }]);
    expect(noSpend.notes()).toEqual([]);
    const noDim = new RowGuard(opts({ dimensions: [], metrics: ["roasClosed", "spend"] }));
    noDim.accept([{ roasClosed: 0, spend: 0 }]);
    expect(noDim.notes()).toEqual([]);
  });
});

describe("filterFieldNames", () => {
  it("collects filter keys and names inside the cross-field filter", () => {
    expect(filterFieldNames({ campaign: "x" }, ["or", { customerPhone: "555" }, { total: ["gte", 1] }]).sort()).toEqual(["campaign", "customerPhone", "total"]);
    expect(filterFieldNames(undefined, undefined)).toEqual([]);
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
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-guards-"));
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
  registerCompareTools(server, ctx);
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

/** Split rows short of the unsplit spend: hb-stl is missing 25, hb-nash nothing. */
const spendRoute: Route = (url) => {
  const fields = url.searchParams.get("fields");
  if (fields === "accountKey,spend") {
    return { body: [{ accountKey: "hb-stl", spend: 125 }, { accountKey: "hb-nash", spend: 40 }] };
  }
  return {
    body: [
      { accountKey: "hb-stl", campaign: "x", spend: 100, leads: 4 },
      { accountKey: "hb-nash", campaign: "x", spend: 40, leads: 2 },
      { accountKey: "", leads: 0, spend: 0 },
    ],
  };
};

describe("searchlight_query_events result guards", () => {
  const base = {
    organization: "hb",
    accounts: ["hb-stl", "hb-nash"],
    fields: ["accountKey", "campaign", "spend", "leads"],
    start: "2026-08-01",
    end: "2026-08-07",
    filters: { attributionChannel: "Google Ads" },
  };

  it("sends exactly one extra request for unsplit spend with the same scope and filters, and reports the shortfall", async () => {
    const { call, api, urls } = await connect(spendRoute);
    const { res, structured, text } = await call("searchlight_query_events", { ...base, subset: undefined });
    expect(res.isError).toBeFalsy();
    const events = api();
    expect(events.map((u) => u.pathname)).toEqual(["/api/hb/events", "/api/hb/events"]);
    const byFields = Object.fromEntries(events.map((u) => [u.searchParams.get("fields"), params(u)]));
    expect(byFields["accountKey,campaign,spend,leads"]).toEqual({
      attributionChannel: "Google Ads",
      fields: "accountKey,campaign,spend,leads",
      start: "2026-08-01",
      end: "2026-08-07",
      accounts: "hb-stl,hb-nash",
    });
    expect(byFields["accountKey,spend"]).toEqual({
      attributionChannel: "Google Ads",
      fields: "accountKey,spend",
      start: "2026-08-01",
      end: "2026-08-07",
      accounts: "hb-stl,hb-nash",
    });
    expect(structured.spendReconciliation).toEqual({
      total: 165,
      inRows: 140,
      missing: 25,
      byAccount: [
        { accountKey: "hb-stl", total: 125, inRows: 100, missing: 25 },
        { accountKey: "hb-nash", total: 40, inRows: 40, missing: 0 },
      ],
    });
    expect(text).toMatch(/Spend on combinations with no tracked events: \$25\.00 of \$165\.00/);
    expect(structured.apiCalls).toBe(urls.length);
    expect(structured.apiCalls).toBe(3);
    // The placeholder row (no campaign, all metrics 0) is dropped and counted.
    expect(structured.rowCount).toBe(2);
    expect(structured.notes).toContainEqual(expect.stringMatching(/^Dropped 1 placeholder row/));
  });

  it("carries the subset onto the extra request", async () => {
    const { call, api } = await connect(spendRoute);
    const access = ACCESS as unknown as { organizations: Array<Record<string, unknown>> };
    access.organizations[0]!.subsets = [{ subset: "hb-east", name: "East", accounts: ["hb-stl", "hb-nash"] }];
    try {
      const { res } = await call("searchlight_query_events", { ...base, accounts: undefined, subset: "hb-east" });
      expect(res.isError).toBeFalsy();
      const extra = api().find((u) => u.searchParams.get("fields") === "accountKey,spend")!;
      expect(params(extra)).toEqual({ attributionChannel: "Google Ads", fields: "accountKey,spend", start: "2026-08-01", end: "2026-08-07", subset: "hb-east" });
    } finally {
      delete access.organizations[0]!.subsets;
    }
  });

  it.each([
    ["reconcile_spend=false", { reconcile_spend: false }],
    ["no dimension", { fields: ["spend", "leads"] }],
    ["only account dimensions", { fields: ["accountKey", "spend"] }],
    ["an interval", { interval: "week" }],
    ["record grain", { fields: ["opportunityId", "spend"] }],
  ])("sends no extra request with %s", async (_label, over) => {
    const { call, api } = await connect(spendRoute);
    const { res, structured } = await call("searchlight_query_events", { ...base, ...over });
    expect(res.isError).toBeFalsy();
    expect(api()).toHaveLength(1);
    expect(structured.spendReconciliation).toBeUndefined();
    expect(structured.notes.join("\n")).not.toMatch(/Spend check|no tracked events/);
  });

  it("keeps placeholder rows when drop_placeholder_rows=false", async () => {
    const { call } = await connect(spendRoute);
    const { structured } = await call("searchlight_query_events", { ...base, drop_placeholder_rows: false, reconcile_spend: false });
    expect(structured.rowCount).toBe(3);
    expect(structured.notes.join("\n")).not.toMatch(/placeholder/);
  });

  it("adds the summing and empty-bucket notes on interval rows", async () => {
    const { call } = await connect(() => ({ body: [{ start: "2026-08-03", end: "2026-08-09", leads: 2, spend: 5 }] }));
    const { structured } = await call("searchlight_query_events", {
      organization: "hb",
      fields: ["leads", "spend"],
      start: "2026-08-03",
      end: "2026-08-16",
      interval: "week",
    });
    expect(structured.notes).toContainEqual(expect.stringMatching(/^Do not add up leads across the week rows/));
    expect(structured.notes).toContainEqual(expect.stringMatching(/^No rows for 1 of 2 week bucket\(s\), starting 2026-08-10\./));
  });

  it("adds the record-grain and dedupe notes", async () => {
    const { call } = await connect(() => ({ body: [{ opportunityId: "o1", leads: 1, bookRate: 1 }] }));
    const { structured } = await call("searchlight_query_events", { organization: "hb", fields: ["opportunityId", "leads", "bookRate"], start: "2026-08-01", end: "2026-08-07" });
    expect(structured.notes).toContainEqual(expect.stringMatching(/bookRate is not meaningful/));
    expect(structured.notes).toContainEqual(expect.stringMatching(/Dedupe on opportunityId/));
  });

  it("explains an empty result filtered on customerPhone", async () => {
    const { call, api } = await connect(() => ({ body: [] }));
    const { structured } = await call("searchlight_query_events", {
      organization: "hb",
      fields: ["campaign", "leads"],
      start: "2026-08-01",
      end: "2026-08-07",
      filters: { customerPhone: "5550100" },
    });
    expect(params(api()[0]!)).toEqual({ customerPhone: "5550100", fields: "campaign,leads", start: "2026-08-01", end: "2026-08-07" });
    expect(structured.notes).toContainEqual(expect.stringMatching(/customerPhone is redacted/));
  });

  it("notes zero-spend rows beside ROAS", async () => {
    const { call } = await connect(() => ({
      body: [
        { attributionChannel: "Paid", roasClosed: 5, spend: 10 },
        { attributionChannel: "Organic", roasClosed: 0, spend: 0 },
      ],
    }));
    const { structured } = await call("searchlight_query_events", {
      organization: "hb",
      fields: ["attributionChannel", "roasClosed", "spend"],
      start: "2026-08-01",
      end: "2026-08-07",
      reconcile_spend: false,
    });
    expect(structured.notes).toContainEqual(expect.stringMatching(/^1 of 2 row\(s\) have zero spend; roasClosed is not meaningful/));
  });
});

describe("searchlight_export_events_csv result guards", () => {
  const args = {
    organization: "hb",
    accounts: ["hb-stl", "hb-nash"],
    fields: ["accountKey", "campaign", "spend", "leads"],
    start: "2026-08-01",
    end: "2026-08-07",
  };

  it("reports the reconciliation without adding rows by default", async () => {
    const { call, api } = await connect(spendRoute);
    const { res, structured } = await call("searchlight_export_events_csv", { ...args, filename: "guards-default" });
    expect(res.isError).toBeFalsy();
    expect(api()).toHaveLength(2);
    expect(params(api().find((u) => u.searchParams.get("fields") === "accountKey,spend")!)).toEqual({
      fields: "accountKey,spend",
      start: "2026-08-01",
      end: "2026-08-07",
      accounts: "hb-stl,hb-nash",
    });
    expect(structured.spendReconciliation.missing).toBe(25);
    expect(structured.rows).toBe(2);
    expect(structured.apiCalls).toBe(3);
    const csv = await fs.readFile(structured.path, "utf8");
    expect(csv).not.toContain(NO_TRACKED_EVENTS);
    expect(structured.notes).toContainEqual(expect.stringMatching(/add_unattributed_spend_row=true appends it/));
  });

  it("appends one row per short account when add_unattributed_spend_row is true", async () => {
    const { call } = await connect(spendRoute);
    const { structured } = await call("searchlight_export_events_csv", { ...args, filename: "guards-append", add_unattributed_spend_row: true });
    expect(structured.rows).toBe(3);
    const lines = (await fs.readFile(structured.path, "utf8")).replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe("accountKey,campaign,spend,leads");
    expect(lines.filter((l) => l.includes(NO_TRACKED_EVENTS))).toEqual([`hb-stl,${NO_TRACKED_EVENTS},25,`]);
    expect(structured.notes).toContainEqual(expect.stringMatching(/^Appended 1 row\(s\)/));
  });
});

describe("searchlight_compare_periods result guards", () => {
  it("adds m_points for rate metrics and the relative-change, revenue and length notes", async () => {
    const { call, api } = await connect((url) =>
      url.searchParams.get("start") === "2026-08-01"
        ? { body: [{ campaign: "a", bookRate: 0.45, leads: 10, soldRevenue: 1000 }] }
        : { body: [{ campaign: "a", bookRate: 0.4, leads: 8, soldRevenue: 500 }] },
    );
    const { res, structured } = await call("searchlight_compare_periods", {
      organization: "hb",
      fields: ["campaign", "bookRate", "leads", "soldRevenue"],
      start: "2026-08-01",
      end: "2026-08-31",
      compare_start: "2026-07-01",
      compare_end: "2026-07-30",
    });
    expect(res.isError).toBeFalsy();
    expect(api().map((u) => params(u))).toEqual(
      expect.arrayContaining([
        { fields: "campaign,bookRate,leads,soldRevenue", start: "2026-08-01", end: "2026-08-31" },
        { fields: "campaign,bookRate,leads,soldRevenue", start: "2026-07-01", end: "2026-07-30" },
      ]),
    );
    const row = structured.rows[0];
    expect(row.bookRate_points).toBeCloseTo(100 * row.bookRate_change, 9);
    expect(row.bookRate_points).toBe(5);
    expect("leads_points" in row).toBe(false);
    expect("soldRevenue_points" in row).toBe(false);
    const notes = structured.notes.join("\n");
    expect(notes).toMatch(/current period is 31 days and the comparison period is 30 days/);
    expect(notes).toMatch(/soldRevenue: a job sold in the earlier period and closed in the later one appears in both/);
    expect(notes).toMatch(/For bookRate, m_pct is the relative change/);
  });

  it("adds none of those notes for equal periods of counts", async () => {
    const { call } = await connect(() => ({ body: [{ campaign: "a", leads: 1 }] }));
    const { structured } = await call("searchlight_compare_periods", { organization: "hb", fields: ["campaign", "leads"], start: "2026-08-01", end: "2026-08-31" });
    expect(structured.notes.join("\n")).not.toMatch(/differ in length|appears in both|m_points/);
    expect("leads_points" in structured.rows[0]).toBe(false);
  });
});
