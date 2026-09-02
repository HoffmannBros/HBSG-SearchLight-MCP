import type { Row } from "./csv.js";

export interface InsightDocument {
  account?: string;
  date?: string;
  insight?: Record<string, unknown>;
  [key: string]: unknown;
}

export const INSIGHT_ROW_COLUMNS = [
  "account",
  "date",
  "period",
  "generated_at",
  "confidence",
  "graded_calls",
  "section",
  "title",
  "summary",
  "action",
  "category",
  "priority",
  "impact_value",
  "impact_unit",
  "impact_display",
  "takeaway",
] as const;

type Item = Record<string, unknown>;

function asItems(value: unknown): Item[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : { title: String(v) }));
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * One row per action item, deep insight, surprise insight, or main theme.
 * A document with none of those still yields one "document" row so nothing
 * silently disappears from the CSV.
 */
export function flattenInsights(docs: InsightDocument[]): Row[] {
  const rows: Row[] = [];
  for (const doc of docs) {
    const insight = (doc.insight ?? {}) as Item;
    const base: Row = {
      account: doc.account ?? insight.account,
      date: doc.date,
      period: insight.period,
      generated_at: insight.generated_at,
      confidence: insight.confidence,
      graded_calls: insight.graded_calls,
    };
    const sections: Array<[string, Item[]]> = [
      ["action_item", asItems(insight.action_items)],
      ["deep_insight", asItems(insight.deep_insights)],
      ["surprise_insight", asItems(insight.surprise_insights)],
      ["main_theme", asItems(insight.main_themes)],
    ];
    let emitted = 0;
    for (const [section, items] of sections) {
      for (const item of items) {
        const impact = item.impact && typeof item.impact === "object" ? (item.impact as Item) : {};
        rows.push({
          ...base,
          section,
          title: str(item.title),
          summary: str(item.summary),
          action: str(item.action),
          category: str(item.category),
          priority: str(item.priority),
          impact_value: impact.value,
          impact_unit: str(impact.unit),
          impact_display: str(impact.display),
          takeaway: str(item.takeaway),
        });
        emitted += 1;
      }
    }
    if (emitted === 0) rows.push({ ...base, section: "document" });
  }
  return rows;
}
