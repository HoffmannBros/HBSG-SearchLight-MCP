/**
 * Probe the live SearchLight API for drift from what this extension assumes.
 * Needs SEARCHLIGHT_API_KEY in .env (or the environment). Uses at most 16
 * GET requests against the hourly limit. Writes smoke-output/probe-<date>.md
 * and .json, which hold counts, codes and field names only (no row values).
 * Usage: npm run probe
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

/** The probe sends requests preflight would refuse, to record what the API itself says. */
class UncheckedClient extends SearchLightClient {
  override preflight(): void {}
}

const client = new UncheckedClient({
  apiKey,
  baseUrl: (process.env.SEARCHLIGHT_BASE_URL || env.SEARCHLIGHT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
  concurrency: 1,
  timeoutMs: 120_000,
  maxAttempts: 1,
});

/** What the extension sends to each endpoint; anything else the API lists is new. */
const PARAMS_WE_USE: Record<string, string[]> = {
  events: ["fields", "start", "end", "interval", "account", "accounts", "filter", "subset"],
  benchmarks: ["fields", "month", "account", "accounts", "subset"],
  insights: ["fields", "start", "end", "account", "accounts", "subset"],
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

/** Fields the API answers that the published field reference does not document (2026-11-11); the probe records which the live dictionary lists. */
const UNDOCUMENTED_FIELDS = ["jobType", "eventId", "agent", "opportunityBooked", "conversionPlannedFollowUpSubcategory"];

/** Grading metric that inflates count metrics requested beside it (knowledge-base claim K4). */
const GRADING_METRIC = "gradedConversions";

/** The two channels the K2 `or` filter check combines. */
const K2_CHANNELS = ["Google Ads", "Google Lsa"];

/** The key caller's cap on account x interval combinations per events call (K10). */
const COMBINATION_CAP = 1000;

type Row = Record<string, unknown>;

const rowsOf = (o: { data?: unknown }): Row[] =>
  Array.isArray(o.data) ? (o.data as unknown[]).filter((r): r is Row => !!r && typeof r === "object") : [];

const sumOf = (rows: Row[], field: string): number => {
  const total = rows.reduce<number>((acc, r) => acc + (Number.isFinite(Number(r[field])) ? Number(r[field]) : 0), 0);
  return Math.round(total * 100) / 100;
};

const present = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Subsets on an organization row, as ids and account counts. Accepts the documented array or an id-keyed object. */
function subsetsOf(org: Record<string, unknown>): Array<{ subset: string; accounts: number | null }> {
  const raw = org.subsets;
  if (Array.isArray(raw)) {
    return raw.map((s: unknown) => {
      if (typeof s === "string") return { subset: s, accounts: null };
      const o = (s ?? {}) as Row;
      const id = o.subset ?? o.id ?? o.name;
      return { subset: typeof id === "string" ? id : "?", accounts: Array.isArray(o.accounts) ? o.accounts.length : null };
    });
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Row).map(([id, v]) => {
      const inner = v && typeof v === "object" && !Array.isArray(v) ? (v as Row).accounts : v;
      return { subset: id, accounts: Array.isArray(inner) ? inner.length : null };
    });
  }
  return [];
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
  // Bundled fields marked `undocumented` answer on events but are not expected in the
  // live dictionary, so they are kept out of the drift diff; section 4 tracks them.
  const allBundledNames = STATIC_FIELDS.map((f) => f.name);
  const staticNames = STATIC_FIELDS.filter((f) => !f.undocumented).map((f) => f.name);
  const undocumentedBundled = STATIC_FIELDS.filter((f) => f.undocumented).map((f) => f.name);

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
    bundledUndocumented: undocumentedBundled,
    undocumentedNowLive: undocumentedBundled.filter((n) => n in dict),
    newInLive: diff(liveNames, allBundledNames).map((n) => `${n} (${dict[n]?.type ?? "?"}): ${dict[n]?.definition ?? ""}`),
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

  // 1. Subsets each organization lists in /api (no request).
  const subsets = (access.organizations ?? []).map((o) => ({
    organization: o.organization,
    hasSubsetsKey: "subsets" in o,
    subsets: subsetsOf(o as Record<string, unknown>),
  }));

  // One account-week for the comparisons, ending yesterday.
  const week = { start: formatIsoDate(addDays(parseIsoDate(yesterday), -6)), end: yesterday };
  const probeAccount = viaOrg ?? org.accounts?.[0];
  const oneAccount: Record<string, string> = probeAccount ? { account: probeAccount } : {};

  // 2. A subset the organization does not have.
  const subsetMiss = await attempt("subset not defined", "4xx", `${orgPath}/events`, { ...oneDay, subset: "probe-not-a-real-subset" });
  delete subsetMiss.data;
  outcomes.push(subsetMiss);

  // 3. `-` as the organization: every account the key reaches.
  const dash = await attempt("`-` as the organization", "200, one row per account", "/api/-/events", { fields: "accountKey,leads", ...week });
  const dashRows = rowsOf(dash);
  const dashReport = {
    status: dash.status,
    code: dash.code,
    rows: dash.status === 200 ? dashRows.length : null,
    distinctAccounts: new Set(dashRows.map((r) => String(r.accountKey ?? ""))).size,
    accountsListedInApi: new Set((access.organizations ?? []).flatMap((o) => o.accounts ?? [])).size,
  };
  delete dash.data;
  outcomes.push(dash);

  // 5. One more account x interval combination than a key caller may ask for.
  const orgAccounts = Math.max(1, org.accounts?.length ?? 1);
  const days = Math.floor(COMBINATION_CAP / orgAccounts) + 1;
  const tooMany = await attempt(`${orgAccounts} account(s) x ${days} days`, "400 too-many-combinations", `${orgPath}/events`, {
    fields: "spend",
    interval: "day",
    start: formatIsoDate(addDays(parseIsoDate(yesterday), -(days - 1))),
    end: yesterday,
  });
  const tooManyReport = {
    accounts: orgAccounts,
    days,
    combinations: orgAccounts * days,
    status: tooMany.status,
    code: tooMany.code,
    rows: tooMany.rows ?? null,
  };
  delete tooMany.data;
  outcomes.push(tooMany);

  // 6 and 7. K1 (split spend) and K4 (grading inflates counts), one account-week.
  // The unsplit request carries spend and leads; neither is a grading metric.
  const base = await attempt("K1/K4 unsplit spend,leads", "200", `${orgPath}/events`, { fields: "spend,leads", ...week, ...oneAccount });
  const split = await attempt("K1 spend by attributionChannel,campaign", "200", `${orgPath}/events`, {
    fields: "attributionChannel,campaign,spend",
    ...week,
    ...oneAccount,
  });
  const graded = await attempt(`K4 leads with ${GRADING_METRIC}`, "200", `${orgPath}/events`, {
    fields: `leads,${GRADING_METRIC}`,
    ...week,
    ...oneAccount,
  });
  const baseRows = rowsOf(base);
  const splitRows = rowsOf(split);
  const gradedRows = rowsOf(graded);
  const k1 = {
    ok: base.status === 200 && split.status === 200,
    unsplitSpend: sumOf(baseRows, "spend"),
    splitSpendSum: sumOf(splitRows, "spend"),
    difference: Math.round((sumOf(baseRows, "spend") - sumOf(splitRows, "spend")) * 100) / 100,
    splitRows: splitRows.length,
  };
  const k4 = {
    ok: base.status === 200 && graded.status === 200,
    leadsAlone: sumOf(baseRows, "leads"),
    leadsWithGrading: sumOf(gradedRows, "leads"),
    gradingMetric: GRADING_METRIC,
  };
  for (const o of [base, split, graded]) {
    delete o.data;
    outcomes.push(o);
  }

  // 8 and 4. K2 (`or` filter on attributionChannel) at conversion grain. The same rows
  // record whether each undocumented field comes back with a value.
  const k2Fields = ["attributionChannel", ...UNDOCUMENTED_FIELDS, "conversions"].join(",");
  const k2Call = (label: string, expected: string, value: unknown) =>
    attempt(label, expected, `${orgPath}/events`, {
      fields: k2Fields,
      ...week,
      ...oneAccount,
      filter: JSON.stringify({ attributionChannel: value }),
    });
  const orCall = await k2Call(`K2 or(${K2_CHANNELS.join(", ")})`, "200, rows = sum of singles", ["or", ...K2_CHANNELS]);
  const singles: Awaited<ReturnType<typeof attempt>>[] = [];
  for (const channel of K2_CHANNELS) singles.push(await k2Call(`K2 ${channel} alone`, "200", channel));
  const k2Calls = [orCall, ...singles];
  const k2 = {
    ok: k2Calls.every((c) => c.status === 200),
    orRows: orCall.status === 200 ? rowsOf(orCall).length : null,
    singleRows: Object.fromEntries(K2_CHANNELS.map((c, i) => [c, singles[i]!.status === 200 ? rowsOf(singles[i]!).length : null])),
  };
  const fieldRows = k2Calls.flatMap(rowsOf);
  const undocumented = UNDOCUMENTED_FIELDS.map((name) => ({
    field: name,
    inLiveDictionary: name in dict,
    queried: k2Calls.some((c) => c.status === 200),
    rowsWithValue: fieldRows.filter((r) => present(r[name])).length,
    rowsChecked: fieldRows.length,
  }));
  for (const o of k2Calls) {
    delete o.data;
    outcomes.push(o);
  }

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
    subsets,
    dashOrganization: dashReport,
    undocumentedFields: undocumented,
    tooManyCombinations: tooManyReport,
    probeWeek: { ...week, account: probeAccount ?? null },
    k1SplitSpend: k1,
    k4GradingInflation: k4,
    k2OrFilter: k2,
  };

  const status = (o: { status: number; code?: string | undefined }) => `${o.status}${o.code ? ` \`${o.code}\`` : ""}`;
  const round = (n: number) => Math.round(n * 100) / 100;
  const failed = "Not measured: a request failed (see Request outcomes).";
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- none");
  const md = [
    `# SearchLight API probe, ${report.probedAt.slice(0, 10)}`,
    `${report.requests} request(s), ${report.elapsedMs} ms. User ${report.user}; probed organization \`${org.organization}\`${viaOrg ? `, account \`${viaOrg}\`` : ""}.`,
    `## Field dictionary\n\nLive ${dictionaryReport.liveFieldCount} fields, bundled ${dictionaryReport.bundledFieldCount}${
      undocumentedBundled.length
        ? ` plus ${undocumentedBundled.length} bundled as undocumented (${undocumentedBundled.join(", ")}), left out of this diff${
            dictionaryReport.undocumentedNowLive.length ? `; now in the live dictionary: ${dictionaryReport.undocumentedNowLive.join(", ")}` : ""
          }`
        : ""
    }.`,
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
    `## Subsets\n\n${list(
      subsets.map((o) =>
        o.subsets.length
          ? `${o.organization}: ${o.subsets.map((s) => `\`${s.subset}\` (${s.accounts ?? "?"} account(s))`).join(", ")}`
          : `${o.organization}: none (${o.hasSubsetsKey ? "empty `subsets`" : "no `subsets` key"})`,
      ),
    )}\n\nAn undefined \`subset\` on events: ${status(subsetMiss)}${subsetMiss.message ? `, "${subsetMiss.message}"` : ""}.`,
    `## \`-\` as the organization\n\n\`/api/-/events\` with \`accountKey,leads\`, ${week.start} to ${week.end}: ${status(dashReport)}, ${dashReport.rows ?? 0} row(s), ${dashReport.distinctAccounts} distinct account key(s). \`/api\` lists ${dashReport.accountsListedInApi} account(s).`,
    `## Undocumented fields\n\nChecked on the K2 rows (conversion grain, ${week.start} to ${week.end}).\n\n| Field | In live dictionary | Rows with a value | Rows checked |\n|---|---|---|---|\n${undocumented
      .map((u) => `| ${u.field} | ${u.inLiveDictionary ? "yes" : "no"} | ${u.queried ? u.rowsWithValue : "query failed"} | ${u.rowsChecked} |`)
      .join("\n")}`,
    `## Too many combinations\n\n${tooManyReport.accounts} account(s) x ${tooManyReport.days} days = ${tooManyReport.combinations} combinations (cap ${COMBINATION_CAP}): ${status(tooManyReport)}${tooManyReport.rows !== null ? `, ${tooManyReport.rows} row(s)` : ""}.`,
    `## K1: spend split by attributionChannel,campaign\n\n${k1.ok ? `One account-week. Unsplit spend ${k1.unsplitSpend}; sum of ${k1.splitRows} split row(s) ${k1.splitSpendSum}; difference ${k1.difference}.` : failed}`,
    `## K4: leads beside ${GRADING_METRIC}\n\n${k4.ok ? `One account-week. \`leads\` without grading ${k4.leadsAlone}; with \`${GRADING_METRIC}\` ${k4.leadsWithGrading} (difference ${round(k4.leadsWithGrading - k4.leadsAlone)}).` : failed}`,
    `## K2: \`or\` filter on attributionChannel\n\n${k2.ok ? `One account-week, conversion grain. \`["or", ${K2_CHANNELS.map((c) => `"${c}"`).join(", ")}]\` ${k2.orRows} row(s); ${K2_CHANNELS.map((c) => `${c} alone ${k2.singleRows[c]} row(s)`).join("; ")}.` : failed}`,
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
