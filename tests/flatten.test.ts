import { describe, expect, it } from "vitest";
import { describeInsight, flattenInsights, INSIGHT_ROW_COLUMNS } from "../src/flatten.js";

const liveItem = {
  kind: "action_item",
  topic: "benchmark_comparison",
  category: "marketing",
  source: "Campaign data",
  title: "ROAS at 10.7x sits 4.8 points below the 15.6x industry benchmark",
  summary: "On $210,491 in spend...",
  takeaway: "Closing the $130 average-ticket gap...",
  action: "Worth discussing with your marketing agency...",
  evidence: { benchmarks: [{ metric: "book_rate", you: 48.3, industry: 36.08 }] },
  priority: "low",
  id: "action_item:benchmark_comparison:65f8a01d14",
  impact_value: 12,
  impact_unit: "pp",
  impact_display: "12 pp",
  client_slug: "hoffmann-brothers",
  account: "Blue Sky Plumbing",
  account_key: "blue-sky-plumbing",
  period: "July 2026",
  generated_at: "2026-08-24T11:10:28.906708+00:00",
  refreshed_this_run: true,
  references: ["https://searchlight.digital/reports/a", "https://searchlight.digital/reports/b"],
  future_investigation: "Identify which peers moved the benchmark",
  first_seen: "2026-08-24",
  change: "new",
  accuracy: { score: 100 },
  confidence: "high",
  review_required: false,
  graded_calls: 0,
};

describe("flattenInsights (live flat items)", () => {
  it("maps one item to one row with nested evidence kept as JSON", () => {
    const rows = flattenInsights([liveItem]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      account: "Blue Sky Plumbing",
      account_key: "blue-sky-plumbing",
      period: "July 2026",
      kind: "action_item",
      topic: "benchmark_comparison",
      priority: "low",
      impact_value: 12,
      impact_unit: "pp",
      impact_display: "12 pp",
      references: "https://searchlight.digital/reports/a https://searchlight.digital/reports/b",
      review_required: false,
      change: "new",
      id: "action_item:benchmark_comparison:65f8a01d14",
    });
    expect(row.evidence).toBe(JSON.stringify(liveItem.evidence));
    for (const key of Object.keys(row)) expect(INSIGHT_ROW_COLUMNS).toContain(key);
  });

  it("handles plain insight items without impact or evidence", () => {
    const rows = flattenInsights([{ kind: "insight", title: "Revenue rose 4.2%", account: "A", period: "July 2026" }]);
    expect(rows[0]).toMatchObject({ kind: "insight", title: "Revenue rose 4.2%", account: "A" });
    expect(rows[0]!.evidence).toBeUndefined();
    expect(rows[0]!.impact_value).toBeUndefined();
  });

  it("describes an item on one line", () => {
    expect(describeInsight(liveItem)).toBe(
      "Blue Sky Plumbing, July 2026: action_item [low] ROAS at 10.7x sits 4.8 points below the 15.6x industry benchmark (12 pp)",
    );
  });
});

describe("flattenInsights (documented wrapper shape)", () => {
  it("emits one row per nested item with the document metadata repeated", () => {
    const rows = flattenInsights([
      {
        account: "acme",
        date: "2026-07-21",
        insight: {
          period: "June 2026",
          generated_at: "2026-07-21T04:00:00Z",
          confidence: "high",
          graded_calls: 412,
          action_items: [
            { title: "6 calls from 'water heater rental'", action: "Add negative keywords", priority: "low", impact: { value: 6, unit: "calls", display: "6 calls" } },
          ],
          deep_insights: [{ title: "Weekend bookings lag", takeaway: "Staff Saturdays", priority: "medium" }],
          main_themes: ["Capacity"],
        },
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ account: "acme", period: "June 2026", graded_calls: 412, kind: "action_item", action: "Add negative keywords", impact_value: 6, impact_display: "6 calls" });
    expect(rows[1]).toMatchObject({ kind: "insight", takeaway: "Staff Saturdays", priority: "medium" });
    expect(rows[2]).toMatchObject({ kind: "main_theme", title: "Capacity" });
  });

  it("keeps documents that have no items", () => {
    const rows = flattenInsights([{ account: "a", date: "2026-01-01", insight: { period: "Dec" } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account: "a", period: "Dec", kind: "document", generated_at: "2026-01-01" });
  });
});
