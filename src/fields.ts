/**
 * Static reference of SearchLight dimensions and metrics, transcribed from
 * https://docs.searchlightdigital.io/api/dimensions/ and /api/metrics/ on
 * 2026-09-02. The live `/api` dictionary is preferred at runtime; this list
 * is the fallback and also powers descriptions when the API is unreachable.
 */

export type FieldType = "dimension" | "metric";

export interface FieldInfo {
  name: string;
  type: FieldType;
  group: string;
  description: string;
  /** Enumerated values, when the docs list them. */
  values?: string[];
  /** Requires the lead-grading subscription; other accounts return 0 or empty. */
  leadGrading?: boolean;
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
  dim("attributionCategory", "Attribution", "Top-level source classification", {
    values: ["Advertising", "Organic", "Other"],
  }),
  dim("attributionChannel", "Attribution", "Platform or pathway the customer came through, e.g. Google Ads, LSA"),
  dim("attributionDetail", "Attribution", "Raw referrer information used for attribution"),
  dim("campaign", "Attribution", "Marketing campaign credited for the customer, e.g. Search - Branded"),
  dim("opportunityJobCampaign", "Attribution", "Campaign reported by the CRM at the customer level"),
  dim("opportunitySource", "Customer", "Lead creation platform, e.g. service-titan-call, what-converts"),
  dim("opportunityType", "Customer", "Lead medium", { values: ["phone", "chat", "form"] }),
  dim("customerStatus", "Customer", "Customer relationship stage", { values: ["New", "Existing", "Unmatched"] }),
  dim("businessUnit", "Customer", "Business unit from the source CRM, e.g. HVAC - Residential - Service"),
  dim("normalizedBusinessUnit", "Customer", "Standardized business unit grouping, e.g. HVAC, Plumbing"),
  dim("opportunityAgent", "Customer", "CSR associated with the customer"),
  dim("technician", "Customer", "Technician who delivered the service"),
  dim("zip", "Customer", "Customer ZIP code"),
  dim("opportunityId", "Customer", "Unique customer identifier"),
  dim("sourceId", "Customer", "Customer identifier in the source system"),
  dim("customerEmail", "Customer", "Customer email address"),
  dim("customerPhone", "Customer", "Customer phone number"),
  dim("adjustedType", "Funnel", "Furthest funnel step the customer reached", {
    values: ["lead-originated", "booked", "estimated", "sold", "closed", "canceled"],
  }),
  dim("typeIsLast", "Funnel", "Boolean: whether this row reflects the customer's current state"),
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
  met("bookedCustomers", "Counts", "Unique customers with an appointment booked in the period"),
  met("canceledCustomers", "Counts", "Unique customers with a cancellation in the period"),
  met("matchedCustomers", "Counts", "Customers matched to source-system activity"),
  met("unmatchedCustomers", "Counts", "Customers not matched to source-system activity"),
  met("payingCustomers", "Counts", "Customers whose current state is sold or closed"),
  met("total", "Revenue", "Total revenue value summed across events from the FSM"),
  met("spend", "Revenue", "Total ad spend, including management fees"),
  met("estimatedRevenue", "Revenue", "Expected revenue of customers currently in the estimated state"),
  met("soldRevenue", "Revenue", "Expected revenue of customers currently in the sold state"),
  met("closedRevenue", "Revenue", "Closed and completed revenue of customers currently in the closed state"),
  met("revenuePotential", "Revenue", "Expected revenue across all customers: unsold estimates plus sold and closed revenue"),
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
];

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

/** Sections of an insight document that `fields` can select. */
export const INSIGHT_SECTIONS = [
  "account",
  "period",
  "generated_at",
  "confidence",
  "graded_calls",
  "action_items",
  "deep_insights",
  "surprise_insights",
  "main_themes",
] as const;

const byName = new Map(STATIC_FIELDS.map((f) => [f.name, f]));
export function staticField(name: string): FieldInfo | undefined {
  return byName.get(name);
}
