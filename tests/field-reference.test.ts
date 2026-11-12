import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SearchLightClient, metriclessFieldsViolation } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import {
  COUNTS_INFLATED_BY_GRADING,
  EXAMPLE_VALUES_NOTE,
  GRADING_METRICS,
  METRIC_GUIDE,
  NOT_MEANINGFUL_AT_RECORD_GRAIN,
  RATE_METRICS,
  RECORD_GRAIN_DIMENSIONS,
  SPEND_BASED,
  STATIC_FIELDS,
  SUMS_ACROSS_INTERVALS,
  UNDOCUMENTED_NOTE,
  staticField,
} from "../src/fields.js";
import { buildCatalog, registerAccessTools } from "../src/tools/access.js";
import { SPEND_BASED as SPEND_BASED_FROM_COMPARE } from "../src/tools/compare.js";

const SETS: Record<string, ReadonlySet<string>> = {
  GRADING_METRICS,
  COUNTS_INFLATED_BY_GRADING,
  RECORD_GRAIN_DIMENSIONS,
  NOT_MEANINGFUL_AT_RECORD_GRAIN,
  SUMS_ACROSS_INTERVALS,
  RATE_METRICS,
  SPEND_BASED,
};

describe("classification sets", () => {
  it("names only fields in the bundled reference", () => {
    const names = new Set(STATIC_FIELDS.map((f) => f.name));
    for (const [set, members] of Object.entries(SETS)) {
      for (const name of members) expect(names.has(name), `${set}: ${name}`).toBe(true);
    }
  });

  it("keeps the metric sets to metrics and the record-grain set to dimensions", () => {
    for (const [set, members] of Object.entries(SETS)) {
      const want = set === "RECORD_GRAIN_DIMENSIONS" ? "dimension" : "metric";
      for (const name of members) expect(staticField(name)?.type, `${set}: ${name}`).toBe(want);
    }
  });

  it("matches the plan's K4 lists exactly", () => {
    expect([...GRADING_METRICS].sort()).toEqual(
      [
        "gradedConversions",
        "bookableConversions",
        "unbookableConversions",
        "bookedConversions",
        "bookableUnbookedConversions",
        "percentConversionsGraded",
        "conversionQuality",
      ].sort(),
    );
    expect([...COUNTS_INFLATED_BY_GRADING].sort()).toEqual(
      [
        "customers",
        "leads",
        "opportunityCount",
        "unmatchedCustomers",
        "bookRate",
        "matchRate",
        "payingCustomerRate",
        "stepBookRate",
        "avgCostPerLead",
      ].sort(),
    );
  });

  it("matches the plan's K6 list exactly", () => {
    expect([...RECORD_GRAIN_DIMENSIONS].sort()).toEqual(
      ["opportunityId", "sourceId", "opportunityStartDate", "adjustedType", "typeIsLast", "firstBooked", "firstClosed", "customerStatus"].sort(),
    );
  });

  it("puts every rate, average, cost-per, ROAS, spend and grading metric in NOT_MEANINGFUL_AT_RECORD_GRAIN", () => {
    const expected = STATIC_FIELDS.filter(
      (f) =>
        f.type === "metric" &&
        (RATE_METRICS.has(f.name) || ["Averages", "ROAS", "Conversion grading"].includes(f.group) || f.name === "spend"),
    ).map((f) => f.name);
    expect([...NOT_MEANINGFUL_AT_RECORD_GRAIN].sort()).toEqual(expected.sort());
    for (const m of ["avgTicket", "avgCostPerLead", "roasClosed", "spend", "bookRate", "conversionQuality"]) {
      expect(NOT_MEANINGFUL_AT_RECORD_GRAIN.has(m), m).toBe(true);
    }
    for (const m of ["leads", "conversions", "closedRevenue"]) expect(NOT_MEANINGFUL_AT_RECORD_GRAIN.has(m), m).toBe(false);
  });

  it("lets only spend sum across intervals", () => {
    expect([...SUMS_ACROSS_INTERVALS]).toEqual(["spend"]);
  });

  it("lists the percent-format metrics as rates, and nothing counted or priced", () => {
    for (const m of ["bookRate", "matchRate", "cancelRate", "stepCloseRate", "conversionQuality"]) expect(RATE_METRICS.has(m), m).toBe(true);
    for (const m of ["leads", "avgTicket", "roasClosed", "spend"]) expect(RATE_METRICS.has(m), m).toBe(false);
  });

  it("re-exports SPEND_BASED from the compare tools unchanged", () => {
    expect(SPEND_BASED_FROM_COMPARE).toBe(SPEND_BASED);
    expect([...SPEND_BASED].sort()).toEqual(
      ["avgCostPerLead", "avgCostPerPayingCustomer", "avgCostPerBookedCustomer", "roasPotential", "roasClosed"].sort(),
    );
  });
});

describe("metric guide", () => {
  it("says safe to sum for no metric but spend", () => {
    for (const [name, text] of Object.entries(METRIC_GUIDE)) {
      if (name !== "spend") expect(text.toLowerCase(), name).not.toContain("safe to sum");
    }
  });

  it("calls spend the one metric that sums exactly, and warns about splits dropping it", () => {
    expect(METRIC_GUIDE.spend).toMatch(/one metric that sums exactly across interval rows/);
    expect(METRIC_GUIDE.spend).toMatch(/campaigns with no tracked events/);
  });

  it("gives closedRevenue the 3% caveat and the 90-day total", () => {
    expect(METRIC_GUIDE.closedRevenue).toMatch(/closest to summable/);
    expect(METRIC_GUIDE.closedRevenue).toMatch(/about 3% over a 90-day total/);
    expect(METRIC_GUIDE.closedRevenue).toMatch(/one total of 90 days or less/);
    expect(METRIC_GUIDE.closedRevenue).toMatch(/2 to 4 weeks/);
  });

  it("warns against summing distinct counts and dividing long windows", () => {
    for (const m of ["customers", "bookedCustomers", "leads"]) {
      expect(METRIC_GUIDE[m], m).toMatch(/never sum interval rows/);
      expect(METRIC_GUIDE[m], m).toMatch(/understates a typical week/);
    }
  });

  it("tells every grading metric to stay apart from the inflated counts", () => {
    for (const m of GRADING_METRICS) {
      expect(METRIC_GUIDE[m], m).toBeDefined();
      for (const c of COUNTS_INFLATED_BY_GRADING) expect(METRIC_GUIDE[m], `${m} names ${c}`).toContain(c);
    }
  });

  it("keeps the caveats that are still true", () => {
    expect(METRIC_GUIDE.soldRevenue).toMatch(/Never sum it across interval rows/);
    expect(METRIC_GUIDE.revenuePotential).toMatch(/Never sum it across interval rows/);
    expect(METRIC_GUIDE.bookableUnbookedConversions).toMatch(/conversionReasonLost/);
    expect(METRIC_GUIDE.leads).toMatch(/1 lead/);
  });
});

describe("undocumented fields", () => {
  it("bundles jobType once, as an undocumented dimension", () => {
    expect(STATIC_FIELDS.filter((f) => f.name === "jobType")).toHaveLength(1);
    expect(staticField("jobType")).toMatchObject({ type: "dimension", undocumented: true });
  });

  it("does not flag fields the live dictionary carries", () => {
    for (const n of ["eventId", "agent", "opportunityBooked", "conversionPlannedFollowUpSubcategory"]) {
      expect(staticField(n)?.undocumented, n).toBeFalsy();
    }
  });

  it("keeps the metricless check working for an undocumented dimension", () => {
    expect(metriclessFieldsViolation("jobType")).toMatch(/at least one metric/);
    expect(metriclessFieldsViolation("jobType,conversions")).toBeNull();
  });
});

describe("buildCatalog", () => {
  const live = {
    user: "me@example.com",
    organizations: [],
    endpoints: [{ endpoint: "events", path: "/api/:org/events", metrics: ["conversions"], dimensions: ["conversionDetailedLabel"] }],
    dictionary: {
      conversions: { type: "metric", definition: "Conversion events", format: "number" },
      conversionDetailedLabel: { type: "dimension", definition: "Grade" },
    },
  };

  it("lists an undocumented field on events even though the live endpoint list omits it", () => {
    const jobType = buildCatalog(live).find((f) => f.name === "jobType")!;
    expect(jobType.undocumented).toBe(true);
    expect(jobType.endpoints).toEqual(["events"]);
  });

  it("lists it on events from the bundled reference when the API is unreachable", () => {
    const jobType = buildCatalog(undefined).find((f) => f.name === "jobType")!;
    expect(jobType.undocumented).toBe(true);
    expect(jobType.endpoints).toEqual(["events"]);
  });

  it("stops calling a field undocumented once the dictionary has it", () => {
    const withJobType = {
      ...live,
      endpoints: [{ ...live.endpoints[0]!, dimensions: ["conversionDetailedLabel", "jobType"] }],
      dictionary: { ...live.dictionary, jobType: { type: "dimension", definition: "Job type" } },
    };
    const jobType = buildCatalog(withJobType).find((f) => f.name === "jobType")!;
    expect(jobType.undocumented).toBeUndefined();
    expect(jobType.endpoints).toEqual(["events"]);
  });

  it("marks bundled values lists as examples", () => {
    const label = buildCatalog(live).find((f) => f.name === "conversionDetailedLabel")!;
    expect(label.values).toContain("Unbookable");
    expect(label.valuesAreExamples).toBe(true);
    expect(buildCatalog(live).find((f) => f.name === "opportunityType")!.valuesAreExamples).toBeUndefined();
  });
});

describe("searchlight_list_fields", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function listFields(args: Record<string, unknown>) {
    const urls: URL[] = [];
    const access = {
      user: "me@example.com",
      organizations: [{ organization: "hb", accounts: ["hb-stl"] }],
      endpoints: [{ endpoint: "events", path: "/api/:org/events", metrics: ["conversions"], dimensions: ["conversionDetailedLabel", "agent"] }],
      dictionary: {
        conversions: { type: "metric", definition: "Conversion events" },
        conversionDetailedLabel: { type: "dimension", definition: "Conversion bookability grade" },
        agent: { type: "dimension", definition: "CSR associated with the conversion" },
      },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      return new Response(JSON.stringify(access), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config = loadConfig({ SEARCHLIGHT_API_KEY: "sl_test", SEARCHLIGHT_BASE_URL: "https://example.test" });
    const ctx: AppContext = {
      config,
      client: new SearchLightClient({ apiKey: "sl_test", baseUrl: config.baseUrl, concurrency: 4, timeoutMs: 5000, fetchImpl, sleep: async () => {} }),
    };
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAccessTools(server, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "0" });
    await client.connect(b);
    const res = await client.callTool({ name: "searchlight_list_fields", arguments: args });
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    return { res, text, urls, structured: res.structuredContent as Record<string, any> };
  }

  it("marks undocumented fields in the endpoints column and the definition", async () => {
    const { res, text, urls, structured } = await listFields({ search: "jobType" });
    expect(res.isError).toBeFalsy();
    expect(urls.map((u) => `${u.pathname}${u.search}`)).toEqual(["/api"]);
    expect(text).toContain("events (undocumented)");
    expect(text).toContain(UNDOCUMENTED_NOTE);
    expect(structured.fields).toEqual([expect.objectContaining({ name: "jobType", undocumented: true, endpoints: ["events"] })]);
  });

  it("keeps undocumented fields when filtering by the events endpoint", async () => {
    const { structured } = await listFields({ endpoint: "events", type: "dimension" });
    const names = (structured.fields as Array<{ name: string }>).map((f) => f.name);
    expect(names).toContain("jobType");
    expect(names).toContain("agent");
  });

  it("does not mark documented fields", async () => {
    const { text } = await listFields({ search: "CSR associated with the conversion" });
    expect(text).toContain("agent");
    expect(text).not.toContain("undocumented");
  });

  it("labels the example values list", async () => {
    const { text } = await listFields({ search: "conversionDetailedLabel" });
    expect(text).toContain(`Unbookable (${EXAMPLE_VALUES_NOTE})`);
  });

  it("does not label a values list that is not marked as examples", async () => {
    const { text } = await listFields({ search: "opportunityType" });
    expect(text).toContain("phone \\| chat \\| form");
    expect(text).not.toContain(EXAMPLE_VALUES_NOTE);
  });

  it("shows the corrected closedRevenue caveat", async () => {
    const { text } = await listFields({ search: "closedRevenue" });
    expect(text).toContain("about 3% over a 90-day total");
    expect(text).not.toMatch(/closedRevenue: [^\n]*safe to sum/);
  });
});
