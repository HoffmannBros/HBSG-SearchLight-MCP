import type { Row } from "./csv.js";

/**
 * One insight item as the live API returns it (verified 2026-09-02): the
 * insights endpoint yields a flat array of items, each with a `kind` of
 * "action_item" or "insight". The docs describe a per-account document
 * wrapper with nested action_items/deep_insights; that shape is handled too
 * in case the API moves to it.
 */
export type InsightItem = Record<string, unknown>;

export const INSIGHT_ROW_COLUMNS = [
  "account",
  "account_key",
  "period",
  "generated_at",
  "first_seen",
  "kind",
  "topic",
  "category",
  "source",
  "priority",
  "confidence",
  "title",
  "summary",
  "takeaway",
  "action",
  "impact_value",
  "impact_unit",
  "impact_display",
  "change",
  "review_required",
  "graded_calls",
  "future_investigation",
  "references",
  "evidence",
  "id",
] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function scalarOrJson(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function references(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  return str(value);
}

/** Map one flat item to a CSV row, keeping nested evidence as JSON text. */
function itemRow(item: Obj, base: Row = {}): Row {
  const impact = isObj(item.impact) ? item.impact : {};
  return {
    ...base,
    account: item.account ?? base.account,
    account_key: item.account_key ?? base.account_key,
    period: item.period ?? base.period,
    generated_at: item.generated_at ?? base.generated_at,
    first_seen: item.first_seen,
    kind: item.kind ?? base.kind,
    topic: item.topic,
    category: item.category,
    source: item.source,
    priority: item.priority,
    confidence: item.confidence ?? base.confidence,
    title: str(item.title),
    summary: str(item.summary),
    takeaway: str(item.takeaway),
    action: str(item.action),
    impact_value: item.impact_value ?? impact.value,
    impact_unit: item.impact_unit ?? impact.unit,
    impact_display: item.impact_display ?? impact.display,
    change: scalarOrJson(item.change),
    review_required: item.review_required,
    graded_calls: item.graded_calls ?? base.graded_calls,
    future_investigation: str(item.future_investigation),
    references: references(item.references),
    evidence: scalarOrJson(item.evidence),
    id: item.id,
  };
}

/** Documented wrapper shape: {account, date, insight: {action_items, deep_insights, ...}}. */
function documentRows(doc: Obj): Row[] {
  const insight = isObj(doc.insight) ? doc.insight : {};
  const base: Row = {
    account: doc.account ?? insight.account,
    account_key: doc.account_key,
    period: insight.period,
    generated_at: insight.generated_at ?? doc.date,
    confidence: insight.confidence,
    graded_calls: insight.graded_calls,
  };
  const sections: Array<[string, unknown]> = [
    ["action_item", insight.action_items],
    ["insight", insight.deep_insights],
    ["surprise_insight", insight.surprise_insights],
    ["main_theme", insight.main_themes],
  ];
  const rows: Row[] = [];
  for (const [kind, list] of sections) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const item: Obj = isObj(entry) ? entry : { title: String(entry) };
      rows.push(itemRow(item, { ...base, kind }));
    }
  }
  if (rows.length === 0) rows.push(itemRow({}, { ...base, kind: "document" }));
  return rows;
}

/** One CSV row per insight item. Nothing is dropped: unknown shapes still yield a row. */
export function flattenInsights(items: InsightItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (!isObj(item)) continue;
    if (isObj(item.insight)) rows.push(...documentRows(item));
    else rows.push(itemRow(item));
  }
  return rows;
}

/** Short one-line label for an item, for inline summaries. */
export function describeInsight(item: InsightItem): string {
  const kind = str(item.kind) ?? "item";
  const account = str(item.account) ?? str(item.account_key) ?? "?";
  const period = str(item.period) ?? "";
  const priority = item.priority ? ` [${str(item.priority)}]` : "";
  const impact = item.impact_display ? ` (${str(item.impact_display)})` : "";
  return `${account}, ${period}: ${kind}${priority} ${str(item.title) ?? ""}${impact}`.trim();
}
