/**
 * Probe the live SearchLight API for drift from what this extension assumes.
 * Needs SEARCHLIGHT_API_KEY in .env (or the environment). Uses about 8
 * requests against the hourly limit. Writes smoke-output/probe-<date>.md and
 * .json. Usage: npm run probe
 *
 * It calls the client directly, not the tools, so the local scope and range
 * checks do not intercept the requests whose API responses it records.
 */
import fs from "node:fs";
import path from "node:path";
import { SearchLightApiError, SearchLightClient, type AccessInfo } from "../src/client.js";
import { DEFAULT_BASE_URL } from "../src/config.js";
import { addDays, formatIsoDate, localToday, parseIsoDate } from "../src/dates.js";
import { BENCHMARK_DIMENSIONS, BENCHMARK_METRICS, METRIC_GUIDE, STATIC_FIELDS } from "../src/fields.js";

const root = path.resolve(import.meta.dirname, "..");
const envFile = path.join(root, ".env");
const env: Record<string, string> = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] && !m[1].startsWith("#")) env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}
const apiKey = process.env.SEARCHLIGHT_API_KEY || env.SEARCHLIGHT_API_KEY;
if (!apiKey) {
  console.error("SEARCHLIGHT_API_KEY is not set. Copy .env.example to .env and add your key.");
  process.exit(2);
}

const client = new SearchLightClient({
  apiKey,
  baseUrl: (process.env.SEARCHLIGHT_BASE_URL || env.SEARCHLIGHT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  concurrency: 1,
  timeoutMs: 120_000,
  maxAttempts: 1,
});

/** What the extension sends to each endpoint; anything else the API lists is new. */
const PARAMS_WE_USE: Record<string, string[]> = {
  events: ["fields", "start", "end", "interval", "account", "accounts", "filter"],
  benchmarks: ["fields", "month", "account", "accounts"],
  insights: ["fields", "start", "end", "account", "accounts"],
};

interface Outcome {
  label: string;
  request: string;
  expected: string;
  status: number;
  code?: string | undefined;
  message?: string | undefined;
  rows?: number | undefined;
}

async function attempt(label: string, expected: string, p: string, params: Record<string, string>): Promise<Outcome & { data?: unknown }> {
  const request = `${p}?${new URLSearchParams(params).toString()}`;
  try {
    const data = await client.get<unknown>(p, params);
    return { label, request, expected, status: 200, rows: Array.isArray(data) ? data.length : undefined, data };
  } catch (err) {
    if (err instanceof SearchLightApiError) return { label, request, expected, status: err.status, code: err.code, message: err.apiMessage };
    return { label, request, expected, status: -1, message: err instanceof Error ? err.message : String(err) };
  }
}

const diff = (a: Iterable<string>, b: Iterable<string>) => {
  const bs = new Set(b);
  return [...new Set(a)].filter((x) => !bs.has(x)).sort();
};

async function main(): Promise<void> {
  const started = Date.now();
  const access = await client.get<AccessInfo>("/api");
  const dict = access.dictionary ?? {};
  const liveNames = Object.keys(dict);
  const staticNames = STATIC_FIELDS.map((f) => f.name);

  const typeMismatches = STATIC_FIELDS.filter((f) => dict[f.name]?.type && dict[f.name]!.type !== f.type).map(
    (f) => `${f.name}: bundled ${f.type}, live ${dict[f.name]!.type}`,
  );
  const liveBenchMetrics = liveNames.filter((n) => dict[n]?.benchmarkable === true);
  const liveBenchDims = liveNames.filter((n) => dict[n]?.benchmarkDimension === true);
  const endpointParams = Object.fromEntries(
    (access.endpoints ?? []).map((e) => [
      e.endpoint,
      { live: e.parameters ?? [], notSentByUs: diff(e.parameters ?? [], PARAMS_WE_USE[e.endpoint] ?? []) },
    ]),
  );
  const benchEndpoint = (access.endpoints ?? []).find((e) => e.endpoint === "benchmarks");
  const enumerable = liveNames
    .filter((n) => Array.isArray(dict[n]?.values))
    .map((n) => `${n} (${(dict[n]!.values as unknown[]).length})`);

  const dictionaryReport = {
    liveFieldCount: liveNames.length,
    bundledFieldCount: staticNames.length,
    newInLive: diff(liveNames, staticNames).map((n) => `${n} (${dict[n]?.type ?? "?"}): ${dict[n]?.definition ?? ""}`),
    missingFromLive: diff(staticNames, liveNames),
    typeMismatches,
    benchmarkMetrics: {
      liveFlagged: liveBenchMetrics.sort(),
      endpointListed: benchEndpoint?.metrics ?? [],
      bundledNotLive: diff(BENCHMARK_METRICS, liveBenchMetrics.length ? liveBenchMetrics : (benchEndpoint?.metrics ?? [])),
      liveNotBundled: diff(liveBenchMetrics.length ? liveBenchMetrics : (benchEndpoint?.metrics ?? []), BENCHMARK_METRICS),
    },
    benchmarkDimensions: {
      liveFlagged: liveBenchDims.sort(),
      endpointListed: benchEndpoint?.dimensions ?? [],
      bundledNotLive: diff(BENCHMARK_DIMENSIONS, liveBenchDims.length ? liveBenchDims : (benchEndpoint?.dimensions ?? [])),
    },
    endpointParams,
    endpointsNotHandled: diff((access.endpoints ?? []).map((e) => e.endpoint), Object.keys(PARAMS_WE_USE)),
    guideMetricsMissingLive: diff(Object.keys(METRIC_GUIDE), liveNames),
    enumerableFields: enumerable,
    entryKeysSeen: [...new Set(liveNames.flatMap((n) => Object.keys(dict[n] ?? {})))].sort(),
  };

  // Pick the organization to probe and an account reached through it.
  const orgNames = new Set((access.organizations ?? []).map((o) => o.organization));
  const org = (access.organizations ?? []).find((o) => (o.accounts ?? []).some((a) => !orgNames.has(a))) ?? access.organizations?.[0];
  if (!org) throw new Error("This key reaches no organizations.");
  const viaOrg = (org.accounts ?? []).find((a) => !orgNames.has(a));
  const yesterday = formatIsoDate(addDays(parseIsoDate(localToday()), -1));
  const oneDay = { fields: "spend", start: yesterday, end: yesterday };
  const orgPath = `/api/${encodeURIComponent(org.organization)}`;

  const outcomes: Outcome[] = [];
  if (viaOrg) {
    outcomes.push(await attempt("account key in path (reached via org)", "404 since 2026-09-21", `/api/${encodeURIComponent(viaOrg)}/events`, oneDay));
  }
  outcomes.push(
    await attempt("account not under org", "404 inaccessible-accounts", `${orgPath}/events`, { ...oneDay, account: "probe-not-a-real-account" }),
  );
  outcomes.push(await attempt("fields with no metric", "400", `${orgPath}/events`, { fields: "account", start: yesterday, end: yesterday }));
  outcomes.push(await attempt("unknown interval", "400", `${orgPath}/events`, { ...oneDay, interval: "fortnight" }));
  outcomes.push(await attempt("start without end", "400 missing-range", `${orgPath}/events`, { fields: "spend", start: yesterday }));

  const insights = await attempt("latest insights, whole items", "200", `${orgPath}/insights`, {});
  const items = Array.isArray(insights.data) ? (insights.data as Array<Record<string, unknown>>) : [];
  const insightsReport = {
    status: insights.status,
    items: items.length,
    shape: items.some((i) => i && typeof i === "object" && "insight" in i) ? "documented wrapper {account,date,insight}" : "flat items",
    keys: [...new Set(items.flatMap((i) => Object.keys(i ?? {})))].sort(),
    kinds: [...new Set(items.map((i) => String(i?.kind ?? "")))].filter(Boolean).sort(),
  };
  delete insights.data;
  outcomes.push(insights);

  const report = {
    probedAt: new Date().toISOString(),
    baseUrl: client.baseUrl,
    user: access.user,
    organization: org.organization,
    accountViaOrganization: viaOrg ?? null,
    organizations: (access.organizations ?? []).map((o) => ({ organization: o.organization, accounts: o.accounts?.length ?? 0 })),
    requests: client.requestCount,
    elapsedMs: Date.now() - started,
    dictionary: dictionaryReport,
    outcomes,
    insights: insightsReport,
  };

  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- none");
  const md = [
    `# SearchLight API probe, ${report.probedAt.slice(0, 10)}`,
    `${report.requests} request(s), ${report.elapsedMs} ms. User ${report.user}; probed organization \`${org.organization}\`${viaOrg ? `, account \`${viaOrg}\`` : ""}.`,
    `## Field dictionary\n\nLive ${dictionaryReport.liveFieldCount} fields, bundled ${dictionaryReport.bundledFieldCount}.`,
    `### In the live dictionary, not bundled\n\n${list(dictionaryReport.newInLive)}`,
    `### Bundled, not in the live dictionary\n\n${list(dictionaryReport.missingFromLive)}`,
    `### Type mismatches\n\n${list(typeMismatches)}`,
    `### Benchmarks\n\nMetrics bundled but not live: ${dictionaryReport.benchmarkMetrics.bundledNotLive.join(", ") || "none"}. Live but not bundled: ${dictionaryReport.benchmarkMetrics.liveNotBundled.join(", ") || "none"}. Dimensions bundled but not live: ${dictionaryReport.benchmarkDimensions.bundledNotLive.join(", ") || "none"}.`,
    `### Endpoint parameters we do not send\n\n${list(Object.entries(endpointParams).map(([e, v]) => `${e}: ${v.notSentByUs.join(", ") || "none"}`))}\n\nEndpoints with no typed tool: ${dictionaryReport.endpointsNotHandled.join(", ") || "none"}.`,
    `### Other\n\nMetric-guide names missing from the live dictionary: ${dictionaryReport.guideMetricsMissingLive.join(", ") || "none"}.\n\nDictionary entry keys: ${dictionaryReport.entryKeysSeen.join(", ")}.\n\nFields with enumerable values: ${enumerable.join(", ") || "none"}.`,
    `## Request outcomes\n\n| Probe | Expected | Status | Code | Message |\n|---|---|---|---|---|\n${outcomes
      .map((o) => `| ${o.label} | ${o.expected} | ${o.status} | ${o.code ?? ""} | ${(o.message ?? (o.rows !== undefined ? `${o.rows} row(s)` : "")).replace(/\|/g, "\\|")} |`)
      .join("\n")}`,
    `## Insights\n\n${insightsReport.items} item(s), ${insightsReport.shape}. Kinds: ${insightsReport.kinds.join(", ") || "none"}.\n\nKeys: ${insightsReport.keys.join(", ")}.`,
  ].join("\n\n");

  const outDir = path.join(root, "smoke-output");
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `probe-${report.probedAt.slice(0, 10)}`);
  fs.writeFileSync(`${stem}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${stem}.md`, `${md}\n`);
  console.log(md);
  console.log(`\nPROBE OK: wrote ${stem}.md and .json`);
}

main().catch((err: unknown) => {
  console.error("PROBE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
