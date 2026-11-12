import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createContext } from "./context.js";
import { withSchemaCompat } from "./schema-compat.js";
import { registerAccessTools } from "./tools/access.js";
import { registerBenchmarkTools } from "./tools/benchmarks.js";
import { registerCompareTools } from "./tools/compare.js";
import { registerEventsTools } from "./tools/events.js";
import { registerInsightTools } from "./tools/insights.js";
import { registerRawTools } from "./tools/raw.js";
import { registerReportTools } from "./tools/reports.js";
import { SERVER_NAME, VERSION } from "./version.js";

const INSTRUCTIONS = `SearchLight is Hoffmann Brothers' marketing attribution and lead-performance platform.
Workflow: searchlight_list_access to find organization and account keys (skip if a default organization is configured), searchlight_list_fields to find dimension and metric names, then searchlight_query_events for inline answers or searchlight_export_events_csv for files. Benchmarks compare against the industry for a month; insights are SearchLight's AI-generated recommendations.
For "how are we doing vs the industry" use searchlight_compare_to_benchmark; for "this period vs last" use searchlight_compare_periods. For a standard spend-to-revenue table use searchlight_performance_report, and for stage counts and step rates use searchlight_funnel_report, rather than building the field list by hand; both include projected revenue or stage revenue and say when a split leaves spend out.
Metrics already carry their definitions; never recompute rates client-side from other rows. Ranges over 90 days need interval=month, week, or day. Narrow to an account with account/accounts, not by putting its key in organization. An organization's subsets are listed by searchlight_list_access and selected with subset; organization "-" means every account the key reaches (no subset with it).
The events tools guard the numbers themselves and say so in notes: they report spend a campaign split leaves out (spendReconciliation), drop all-zero placeholder rows, name metrics that must not be summed across rows, retry an empty "or" filter one value at a time, and cross-check an all-zero long total. Keep grading metrics (gradedConversions and the rest) out of calls that ask for leads, customers, or bookRate.
Reading the numbers: closed revenue (roasClosed, closedRevenue) posts 2 to 4 weeks after the work, so a drop in the current or just-finished month is usually lag. ROAS means nothing for channels with no spend. leads counts people, conversions counts calls and forms. bookRate counts every contact including spam and out-of-area calls, so check unbookableConversions before blaming CSRs. A low matchRate is a data-quality problem that understates revenue, not a performance one. Revenue: within one row, soldRevenue + closedRevenue is the projected closed total for work sold so far. Only spend sums exactly across interval rows. Never sum any other metric across interval rows or separate periods: a customer active in two buckets is counted in each, and a job sold in one period and closed in the next is in both. closedRevenue is closest (monthly rows run about 3% high) and fine for trending. For an exact window total, request one interval=total row of 90 days or less; over 90 days, sum closedRevenue and add soldRevenue from the latest period only. total is not revenue (it counts every estimate). searchlight_list_fields shows these caveats per metric.`;

export function buildServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const ctx = createContext(env);
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  registerAccessTools(server, ctx);
  registerEventsTools(server, ctx);
  registerBenchmarkTools(server, ctx);
  registerCompareTools(server, ctx);
  registerInsightTools(server, ctx);
  registerRawTools(server, ctx);
  registerReportTools(server, ctx);
  if (!ctx.config.apiKey) {
    console.error("[hbsg-searchlight] SEARCHLIGHT_API_KEY is not set; tools will return a configuration error until it is.");
  }
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  await server.connect(withSchemaCompat(new StdioServerTransport()));
}

main().catch((err: unknown) => {
  console.error("[hbsg-searchlight] fatal:", err);
  process.exit(1);
});
