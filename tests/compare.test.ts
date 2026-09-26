import { describe, expect, it } from "vitest";
import { benchmarkStanding, classifyFields, joinPeriods, joinedColumns, sortByChange } from "../src/compare.js";

const dist = { benchmark: 0.4, p10: 0.2, p25: 0.3, p50: 0.4, p75: 0.5, p90: 0.6 };

describe("benchmarkStanding", () => {
  it("reads higher-is-better metrics from the top", () => {
    expect(benchmarkStanding(0.65, dist, false)).toEqual({ band: ">p90", standing: "top 10%", vsBenchmark: 0.65 / 0.4 });
    expect(benchmarkStanding(0.5, dist, false)?.standing).toBe("top 25%");
    expect(benchmarkStanding(0.45, dist, false)?.standing).toBe("better than median");
    expect(benchmarkStanding(0.35, dist, false)?.standing).toBe("worse than median");
    expect(benchmarkStanding(0.2, dist, false)).toMatchObject({ band: "p10-p25", standing: "bottom 25%" });
    expect(benchmarkStanding(0.1, dist, false)).toMatchObject({ band: "<p10", standing: "bottom 10%" });
  });

  it("reads lower-is-better metrics from the bottom", () => {
    const cost = { benchmark: 50, p10: 20, p25: 30, p50: 40, p75: 60, p90: 80 };
    expect(benchmarkStanding(15, cost, true)).toMatchObject({ band: "<p10", standing: "top 10%" });
    expect(benchmarkStanding(30, cost, true)?.standing).toBe("top 25%");
    expect(benchmarkStanding(40, cost, true)?.standing).toBe("better than median");
    expect(benchmarkStanding(70, cost, true)?.standing).toBe("bottom 25%");
    expect(benchmarkStanding(90, cost, true)).toMatchObject({ band: ">p90", standing: "bottom 10%" });
  });

  it("returns null without a full distribution, and no ratio against a zero benchmark", () => {
    expect(benchmarkStanding(0.4, { p10: 0.2 }, false)).toBeNull();
    expect(benchmarkStanding(0.4, { ...dist, benchmark: 0 }, false)?.vsBenchmark).toBeNull();
  });
});

describe("classifyFields", () => {
  it("prefers the live dictionary, falls back to the bundled list, and treats unknowns as dimensions", () => {
    const live = { newMetric: { type: "metric" } };
    expect(classifyFields(["campaign", "spend", "newMetric", "mystery"], live)).toEqual({
      dimensions: ["campaign", "mystery"],
      metrics: ["spend", "newMetric"],
    });
    expect(classifyFields(["account", "leads"], undefined)).toEqual({ dimensions: ["account"], metrics: ["leads"] });
  });
});

describe("joinPeriods", () => {
  const cur = [
    { account: "A", campaign: "x", spend: 100, leads: 10 },
    { account: "A", campaign: "y", spend: 50, leads: 0 },
  ];
  const prev = [
    { account: "A", campaign: "x", spend: 80, leads: 0 },
    { account: "B", campaign: "x", spend: 20, leads: 2 },
  ];

  it("joins on every dimension and computes change and percent change", () => {
    const rows = joinPeriods(cur, prev, ["account", "campaign"], ["spend", "leads"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      account: "A",
      campaign: "x",
      spend: 100,
      spend_prev: 80,
      spend_change: 20,
      spend_pct: 0.25,
      leads: 10,
      leads_prev: 0,
      leads_change: 10,
      leads_pct: null,
    });
  });

  it("keeps rows from only one side with nulls on the other", () => {
    const rows = joinPeriods(cur, prev, ["account", "campaign"], ["spend"]);
    expect(rows[1]).toMatchObject({ campaign: "y", spend: 50, spend_prev: null, spend_change: null });
    expect(rows[2]).toMatchObject({ account: "B", spend: null, spend_prev: 20 });
  });

  it("joins a metrics-only query as one row", () => {
    expect(joinPeriods([{ spend: 3 }], [{ spend: 1 }], [], ["spend"])).toEqual([
      { spend: 3, spend_prev: 1, spend_change: 2, spend_pct: 2 },
    ]);
  });

  it("orders columns and sorts by absolute change with nulls last", () => {
    expect(joinedColumns(["account"], ["spend"])).toEqual(["account", "spend", "spend_prev", "spend_change", "spend_pct"]);
    const rows = sortByChange(joinPeriods(cur, prev, ["account", "campaign"], ["spend"]), "spend");
    expect(rows.map((r) => r.spend_change)).toEqual([20, null, null]);
  });
});
