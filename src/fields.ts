/**
 * Static reference of SearchLight dimensions and metrics, transcribed from
 * https://docs.searchlightdigital.io/api/dimensions/ and /api/metrics/ on
 * 2026-09-02 and brought in line with the live `/api` dictionary on
 * 2026-09-28 (`npm run probe`). The live dictionary is preferred at runtime;
 * this list is the fallback and also powers descriptions when the API is
 * unreachable.
 */

export type FieldType = "dimension" | "metric";

/** The live dictionary's `preferredDirection`: which way a metric improves. */
export type Direction = "up" | "down" | "neutral";

export interface FieldInfo {
  name: string;
  type: FieldType;
  group: string;
  description: string;
  /** Enumerated values, when the docs list them. */
  values?: string[];
  /** Requires the lead-grading subscription; other accounts return 0 or empty. */
  leadGrading?: boolean;
  /** Metrics only: which way is better, from the live dictionary. Absent when it gives none. */
  direction?: Direction;
  /**
   * In the live dictionary but on no endpoint's field list (2026-09-28), so a
   * request for it is rejected. Kept so definitions still show offline.
   */
  dictionaryOnly?: boolean;
}

const dim = (
  name: string,
  group: string,
  description: string,
  extra: Partial<Pick<FieldInfo, "values" | "leadGrading">> = {},
): FieldInfo => ({ name, type: "dimension", group, description, ...extra });

const met = (
  name: string,
  group: string,
  description: string,
  extra: Partial<Pick<FieldInfo, "leadGrading">> = {},
): FieldInfo => ({ name, type: "metric", group, description, ...extra });

export const DIMENSIONS: FieldInfo[] = [
  dim("account", "Account", "Business or brand display name, e.g. Example Home Services"),
  dim("accountKey", "Account", "Unique account identifier, e.g. example-home-services"),
  dim("accountName", "Account", "Business, brand, or entity providing services"),
  dim("accountIndex", "Account", "Account identifier local to the returned dataset only"),
  dim("attributionCategory", "Attribution", "Top-level source classification", {
    values: ["Advertising", "Organic", "Other"],
  }),
  dim("attributionChannel", "Attribution", "Platform or pathway the customer came through, e.g. Google Ads, LSA"),
  dim("attributionDetail", "Attribution", "Raw referrer information used for attribution"),
  dim("campaign", "Attribution", "Marketing campaign credited for the customer, e.g. Search - Branded"),
  dim("opportunityJobCampaign", "Attribution", "Campaign reported by the CRM at the customer level"),
  dim("attributionDropDate", "Attribution", "Date a direct mail piece is attributed to a customer and released for delivery"),
  dim("conversionAttribution", "Conversion", "Attribution of the conversion event"),
  dim("conversionCategory", "Conversion", "Referral category of the conversion event"),
  dim("conversionChannel", "Conversion", "Referral channel of the conversion event"),
  dim("conversionCampaign", "Conversion", "Campaign of the conversion event"),
  dim("conversionType", "Conversion", "Type of conversion, e.g. form, phone"),
  dim("conversionDropDate", "Conversion", "Date a direct mail provider released the mail piece for delivery"),
  dim("source", "Conversion", "Original source, platform, or system that created the conversion"),
  dim("agent", "Conversion", "CSR associated with the conversion"),
  dim("detail", "Conversion", "Unstructured information about the lead from the source system"),
  dim("opportunitySource", "Customer", "Lead creation platform, e.g. service-titan-call, what-converts"),
  dim("opportunityType", "Customer", "Lead medium", { values: ["phone", "chat", "form"] }),
  dim("customerStatus", "Customer", "Customer relationship stage", { values: ["New", "Existing", "Unmatched"] }),
  dim("businessUnit", "Customer", "Business unit from the source CRM, e.g. HVAC - Residential - Service"),
  dim("normalizedBusinessUnit", "Customer", "Standardized business unit grouping, e.g. HVAC, Plumbing"),
  dim("opportunityAgent", "Customer", "CSR associated with the customer"),
  dim("customerName", "Customer", "Customer name from the FSM when matched, otherwise from the lead"),
  dim("technician", "Customer", "Technician who delivered the service"),
  dim("zip", "Customer", "Customer ZIP code"),
  dim("opportunityId", "Customer", "Unique customer identifier"),
  dim("sourceId", "Customer", "Customer identifier in the source system"),
  dim("opportunitySourceId", "Customer", "Source ID attributed to the opportunity"),
  dim("eventId", "Customer", "Unique event identifier"),
  dim("customerEmail", "Customer", "Customer email address"),
  dim("customerPhone", "Customer", "Customer phone number"),
  dim("adjustedType", "Funnel", "Furthest funnel step the customer reached", {
    values: ["lead-originated", "booked", "estimated", "sold", "closed", "canceled"],
  }),
  dim("typeIsLast", "Funnel", "Boolean: whether this row reflects the customer's current state"),
  dim("opportunityBooked", "Funnel", "Boolean: whether the customer eventually booked, including after the time frame"),
  dim("conversionDetailedLabel", "Lead grading", "Conversion bookability grade", {
    values: ["Bookable - Booked", "Bookable - Didn't Book", "Unbookable"],
    leadGrading: true,
  }),
  dim("conversionIntent", "Lead grading", "Caller or submitter intent", { leadGrading: true }),
  dim("conversionReasonUnbookable", "Lead grading", "Why the conversion was unbookable, e.g. Out Of Service Area, Spam", {
    leadGrading: true,
  }),
  dim("conversionReasonLost", "Lead grading", "Why a bookable conversion did not book, e.g. Pricing Concerns", {
    leadGrading: true,
  }),
  dim("conversionOutOfServiceAreaZip", "Lead grading", "ZIP from out-of-service-area conversions", { leadGrading: true }),
  dim("conversionNotOfferedServiceRequested", "Lead grading", "Service requested on not-offered conversions", {
    leadGrading: true,
  }),
  dim("conversionNeedsManagementReview", "Lead grading", "Boolean flag for manager review", { leadGrading: true }),
  dim("conversionPlannedFollowUpSubcategory", "Lead grading", "Reason breakout for conversions marked Planned Follow Up", {
    leadGrading: true,
  }),
  dim("conversionVersion", "Lead grading", "Version of SearchLight's lead grading model", { leadGrading: true }),
  dim("conversionOriginalDetailedLabel", "Lead grading", "Original grade before any update", { leadGrading: true }),
  dim("conversionOriginalIntent", "Lead grading", "Original intent before any update", { leadGrading: true }),
  dim("conversionOriginalReasonUnbookable", "Lead grading", "Original unbookable reason before any update", {
    leadGrading: true,
  }),
  dim("conversionOriginalReasonLost", "Lead grading", "Original lost reason before any update", { leadGrading: true }),
  dim("opportunityDetailedLabel", "Lead grading", "Customer-level bookability grade", { leadGrading: true }),
  dim("opportunityReasonUnbookable", "Lead grading", "Customer-level unbookable reason", { leadGrading: true }),
  dim("opportunityReasonLost", "Lead grading", "Customer-level lost reason", { leadGrading: true }),
  dim("opportunityIntent", "Lead grading", "Customer-level intent", { leadGrading: true }),
  dim("conversionTranscript", "Lead grading", "Call or chat transcript (drilldown text)", { leadGrading: true }),
  dim("conversionCallOrChatSummary", "Lead grading", "Summary of the call or chat (drilldown text)", { leadGrading: true }),
  dim("recordingPlayer", "Lead grading", "Recording player link (drilldown)", { leadGrading: true }),
  dim("opportunityTranscript", "Lead grading", "Customer-level transcript (drilldown text)", { leadGrading: true }),
  dim("date", "Time", "Event date, YYYY-MM-DD"),
  dim("dateTime", "Time", "Event timestamp, ISO 8601 UTC"),
  dim("createdDateTime", "Time", "Event creation timestamp, ISO 8601 UTC"),
  dim("week", "Time", "Calendar week starting Monday"),
  dim("month", "Time", "Calendar month"),
  dim("opportunityStartDate", "Time", "Customer origination date"),
  dim("firstBooked", "Time", "Earliest booked event date"),
  dim("firstEstimated", "Time", "Earliest estimated event date"),
  dim("firstSold", "Time", "Earliest sold event date"),
  dim("firstClosed", "Time", "Earliest closed event date"),
  dim("firstCanceled", "Time", "Earliest canceled event date"),
];

export const METRICS: FieldInfo[] = [
  met("conversions", "Counts", "Conversion events; not unique by customer"),
  met("eventCount", "Counts", "Total events, including multiple events per customer"),
  met("leads", "Counts", "Unique leads: distinct customers whose first event was a conversion"),
  met("soldLeads", "Counts", "Leads that reached a sold state at least once"),
  met("closedLeads", "Counts", "Leads that reached a closed state at least once"),
  met("opportunityCount", "Counts", "Distinct opportunities in the result"),
  met("customers", "Counts", "Distinct customers, by current state"),
  met("opportunityAgents", "Counts", "Distinct CSRs who supported customers in the time frame"),
  met("bookedCustomers", "Counts", "Unique customers with an appointment booked in the period"),
  met("canceledCustomers", "Counts", "Unique customers with a cancellation in the period"),
  met("matchedCustomers", "Counts", "Customers matched to source-system activity"),
  met("unmatchedCustomers", "Counts", "Customers not matched to source-system activity"),
  met("payingCustomers", "Counts", "Customers whose current state is sold or closed"),
  met("total", "Revenue", "Total revenue value summed across events from the FSM"),
  met("spend", "Revenue", "Total ad spend, including management fees"),
  met("campaignSpend", "Revenue", "Spend from ad providers and management fees across the populated digital channels"),
  met("estimatedRevenue", "Revenue", "Expected revenue of customers currently in the estimated state"),
  met("soldRevenue", "Revenue", "Expected revenue of customers currently in the sold state"),
  met("closedRevenue", "Revenue", "Closed and completed revenue of customers currently in the closed state"),
  met("revenuePotential", "Revenue", "Expected revenue across all customers: unsold estimates plus sold and closed revenue"),
  met("expectedValue", "Revenue", "Revenue using the average rather than the sum of estimates per customer, so aggregates are not inflated"),
  met("avgConversionsPerLead", "Averages", "conversions / leads"),
  met("avgCostPerConversion", "Averages", "spend / conversions"),
  met("avgCostPerLead", "Averages", "spend / leads"),
  met("avgCostPerPayingCustomer", "Averages", "spend / payingCustomers"),
  met("avgCostPerBookedCustomer", "Averages", "spend / bookedCustomers"),
  met("avgTicket", "Averages", "Expected revenue of paying customers / payingCustomers"),
  met("bookRate", "Rates", "bookedCustomers / customers"),
  met("matchRate", "Rates", "matchedCustomers / customers"),
  met("payingCustomerRate", "Rates", "payingCustomers / customers"),
  met("customerCancelRate", "Rates", "canceledCustomers / customers"),
  met("cancelRate", "Rates", "Of customers who booked in the period, the fraction later canceled"),
  met("roasPotential", "ROAS", "revenuePotential / spend"),
  met("roasClosed", "ROAS", "closedRevenue / spend"),
  met("gradedConversions", "Conversion grading", "Conversions that have been graded", { leadGrading: true }),
  met("bookableConversions", "Conversion grading", "Conversions graded bookable, booked or not", { leadGrading: true }),
  met("unbookableConversions", "Conversion grading", "Conversions graded unbookable", { leadGrading: true }),
  met("bookedConversions", "Conversion grading", "Conversions graded bookable and booked", { leadGrading: true }),
  met("bookableUnbookedConversions", "Conversion grading", "Conversions graded bookable that did not book", {
    leadGrading: true,
  }),
  met("percentConversionsGraded", "Conversion grading", "gradedConversions / conversions", { leadGrading: true }),
  met("conversionQuality", "Conversion grading", "bookableConversions / gradedConversions", { leadGrading: true }),
  met("stepBookRate", "Funnel steps", "Of leads originated in the period, the fraction eventually booked"),
  met("stepEstimateRate", "Funnel steps", "Of customers first booked in the period, the fraction eventually estimated"),
  met("stepSoldRate", "Funnel steps", "Of customers first estimated in the period, the fraction eventually sold"),
  met("stepCloseRate", "Funnel steps", "Of customers first sold in the period, the fraction eventually closed"),
  met("clicks", "Google Ads", "Clicks, as reported by Google Ads"),
  met("impressions", "Google Ads", "Impressions, as reported by Google Ads"),
  met("cost", "Google Ads", "Cost, as reported by Google Ads"),
  met("allConversions", "Google Ads", "Conversions, as reported by Google Ads (not SearchLight's conversions)"),
  met("searchImpressionShare", "Google Ads", "Search impression share, as reported by Google Ads"),
  met("searchLostIsBudget", "Google Ads", "Search impression share lost to budget, as reported by Google Ads"),
  met("searchLostIsRank", "Google Ads", "Search impression share lost to rank, as reported by Google Ads"),
];

/** `preferredDirection` per metric, from the live dictionary on 2026-09-28. */
const DIRECTIONS: Record<string, Direction> = {
  ...Object.fromEntries(
    [
      "conversions", "leads", "soldLeads", "closedLeads", "customers", "bookedCustomers", "matchedCustomers",
      "payingCustomers", "total", "estimatedRevenue", "soldRevenue", "closedRevenue", "revenuePotential",
      "expectedValue", "avgTicket", "bookRate", "matchRate", "payingCustomerRate", "roasPotential", "roasClosed",
      "bookableConversions", "bookedConversions", "conversionQuality", "stepBookRate", "stepEstimateRate",
      "stepSoldRate", "stepCloseRate",
    ].map((m) => [m, "up" as const]),
  ),
  ...Object.fromEntries(
    [
      "avgConversionsPerLead", "avgCostPerConversion", "avgCostPerLead", "avgCostPerBookedCustomer",
      "avgCostPerPayingCustomer", "canceledCustomers", "customerCancelRate", "cancelRate", "unbookableConversions",
      "bookableUnbookedConversions",
    ].map((m) => [m, "down" as const]),
  ),
  ...Object.fromEntries(
    ["spend", "campaignSpend", "unmatchedCustomers", "opportunityAgents", "gradedConversions", "percentConversionsGraded"].map(
      (m) => [m, "neutral" as const],
    ),
  ),
};
/** Dictionary metrics that no endpoint accepted on 2026-09-28. */
const DICTIONARY_ONLY = new Set([
  "clicks", "impressions", "cost", "allConversions", "searchImpressionShare", "searchLostIsBudget", "searchLostIsRank",
  "campaignSpend", "expectedValue", "opportunityAgents",
]);
for (const m of METRICS) {
  const direction = DIRECTIONS[m.name];
  if (direction) m.direction = direction;
  if (DICTIONARY_ONLY.has(m.name)) m.dictionaryOnly = true;
}

export const STATIC_FIELDS: FieldInfo[] = [...DIMENSIONS, ...METRICS];

/** Metrics the benchmarks endpoint supports. */
export const BENCHMARK_METRICS = [
  "bookRate",
  "matchRate",
  "payingCustomerRate",
  "customerCancelRate",
  "avgTicket",
  "avgCostPerLead",
  "avgCostPerPayingCustomer",
  "avgCostPerBookedCustomer",
  "roasPotential",
  "roasClosed",
] as const;

/** Dimensions the benchmarks endpoint supports, for grouping and filtering. */
export const BENCHMARK_DIMENSIONS = [
  "attributionCategory",
  "attributionChannel",
  "customerStatus",
  "normalizedBusinessUnit",
] as const;

/**
 * Keys of an insight item that `fields` can select (observed on the live API
 * 2026-09-02 and 2026-09-28; the docs list a different, nested shape).
 */
export const INSIGHT_FIELDS = [
  "kind",
  "topic",
  "category",
  "source",
  "title",
  "summary",
  "takeaway",
  "action",
  "evidence",
  "priority",
  "id",
  "impact_value",
  "impact_unit",
  "impact_display",
  "account",
  "account_key",
  "period",
  "generated_at",
  "first_seen",
  "change",
  "confidence",
  "accuracy",
  "review_required",
  "graded_calls",
  "references",
  "future_investigation",
  "client_slug",
  "last_material_change",
  "refreshed_this_run",
] as const;

const byName = new Map(STATIC_FIELDS.map((f) => [f.name, f]));
export function staticField(name: string): FieldInfo | undefined {
  return byName.get(name);
}

/**
 * How to read the core metrics without the common misreads, condensed from
 * the "Interpreting the core metrics" section of the metrics reference
 * (docs.searchlightdigital.io/api/metrics, read 2026-09-26). The revenue
 * entries on summing across periods come from a live check on 2026-10-09.
 */
export const METRIC_GUIDE: Record<string, string> = {
  leads:
    "Unique people, counted once each. conversions counts every call and form (one person calling three times is 3 conversions, 1 lead); use leads when the question is about people.",
  conversions: "Every call, chat, and form, not unique by person. Use leads for people.",
  bookRate:
    "The denominator is every tracked contact with no exclusions, so spam, wrong numbers, and out-of-area calls pull it down. Check unbookableConversions before blaming the CSRs, and expect it to read lower than a CRM book rate. Below 35% usually warrants a look; above 55% is strong.",
  bookableUnbookedConversions:
    "Real demand that didn't book, the most direct missed-revenue signal. The reason matters: a Planned Follow Up is pending revenue, no availability is a scheduling gap. Break it out by conversionReasonLost.",
  roasClosed:
    "Counts only closed, invoiced jobs, which post 2 to 4 weeks after the work. A drop in the current or just-finished month is usually lag, not performance. Meaningless for channels with no spend (Direct, Organic, AI). Compare to the same channel in prior periods; home-services paid search usually runs 4x to 10x.",
  roasPotential: "Includes sold and estimated revenue, so it leads roasClosed. Meaningless for channels with no spend.",
  soldRevenue:
    "Jobs sold but not yet closed, at the customer's last step in the period. Within one row, soldRevenue + closedRevenue is the projected closed total for work sold so far; a customer is never in both. Never sum it across interval rows or separate periods: a job sold in July and closed in August is in July's soldRevenue and August's closedRevenue (monthly rows summed to more than double the true figure in a live check). For a range over 90 days, sum closedRevenue and add soldRevenue from the latest period only.",
  closedRevenue:
    "Closed, invoiced jobs; posts 2 to 4 weeks after the work. The one revenue metric that is safe to sum or trend across interval rows. Within one row, add soldRevenue for the projected closed total.",
  estimatedRevenue:
    "Open estimates for customers whose last step in the period is estimated, averaged per customer. Never sum it across interval rows or separate periods; an estimate that later sells is counted again as sold or closed.",
  revenuePotential:
    "estimatedRevenue + soldRevenue + closedRevenue, each customer counted once at their last step in the period. Safe to add across dimensions within one query. Never sum it across interval rows or separate periods (monthly rows overstate a quarter by about 17%); request the range as one interval=total row instead.",
  payingCustomers:
    "Customers whose last step in the period is sold or closed. Never sum it across interval rows or separate periods; a customer sold in one month and closed in the next is counted in both.",
  total:
    "Not a revenue figure: it sums every FSM event, including every estimate on a job, and runs several times revenuePotential. Use closedRevenue, soldRevenue, or revenuePotential.",
  avgTicket:
    "Revenue per paying customer. Shifts with job mix (more small jobs pulls it down); check the job count alongside it before reading it as pricing.",
  matchRate:
    "A data-quality measure, not performance: the share of contacts SearchLight linked to an FSM job. A low value means revenue and ROAS are understated, often from missing phone numbers or a sync problem.",
};

/** Metrics where a lower value is the better one, per the bundled directions. */
export const LOWER_IS_BETTER: ReadonlySet<string> = new Set(METRICS.filter((m) => m.direction === "down").map((m) => m.name));
