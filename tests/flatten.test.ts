import { describe, expect, it } from "vitest";
import { flattenInsights } from "../src/flatten.js";

describe("flattenInsights", () => {
  it("emits one row per item with the document metadata repeated", () => {
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
            {
              title: "6 calls from 'water heater rental'",
              summary: "s",
              action: "Add negative keywords",
              category: "ads",
              priority: "low",
              impact: { value: 6, unit: "calls", display: "6 calls" },
            },
          ],
          deep_insights: [{ title: "Weekend bookings lag", summary: "d", takeaway: "Staff Saturdays", priority: "medium" }],
          main_themes: ["Capacity"],
        },
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      account: "acme",
      date: "2026-07-21",
      period: "June 2026",
      graded_calls: 412,
      section: "action_item",
      action: "Add negative keywords",
      impact_value: 6,
      impact_unit: "calls",
      impact_display: "6 calls",
    });
    expect(rows[1]).toMatchObject({ section: "deep_insight", takeaway: "Staff Saturdays", priority: "medium" });
    expect(rows[2]).toMatchObject({ section: "main_theme", title: "Capacity" });
  });

  it("keeps documents that have no items", () => {
    const rows = flattenInsights([{ account: "a", date: "2026-01-01", insight: { period: "Dec" } }]);
    expect(rows).toEqual([
      {
        account: "a",
        date: "2026-01-01",
        period: "Dec",
        generated_at: undefined,
        confidence: undefined,
        graded_calls: undefined,
        section: "document",
      },
    ]);
  });
});
