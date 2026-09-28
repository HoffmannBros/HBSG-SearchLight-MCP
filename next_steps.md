# next_steps.md

Handoff state for HBSG-SearchLight-MCP.

**Last updated:** 2026-09-28 (v1.1.0 merged to `main` and tagged `v1.1.0`)

## Goal

Claude Desktop extension (.mcpb) covering the whole SearchLight API (`/api`, events,
benchmarks, insights) with CSV export and automatic chunking for large pulls. TypeScript on
Node, bundled to one file with esbuild. Team members install the bundle and paste their own
`sl_` API key. Windows and macOS.

Approved plan: `~/.claude/plans/i-want-to-build-spicy-walrus.md` (copy of the design lives in
`docs/superpowers/specs/2026-09-02-searchlight-mcp-design.md`).

## Where things stand

| Step | Status |
|---|---|
| Repo, scaffold, remote `HoffmannBros/HBSG-SearchLight-MCP` | done, pushed |
| config, csv spool, filters, dates, fields reference, client, chunking, 9 tools | done, 90 tests pass (`npm test`) |
| manifest.json (v0.4, node), README, CLAUDE.md, scripts/pack.sh, scripts/smoke.ts | done |
| `npm run pack` | passes; `dist/hbsg-searchlight-1.0.1.mcpb`, 272 KB, starts in ~58 ms |
| **`.mcpbignore` missed `AGENTS.md` (2026-09-14)** | **fixed; pack was failing its own contents check** |
| Windows clone set up and verified (2026-09-14) | done: build, 90 tests, live smoke, pack all pass |
| **Live smoke against the real API (2026-09-02)** | **PASSED**: all 9 tools; see below |
| Install v1.0.0 in Claude Desktop and try | done; found two bugs, fixed in v1.0.1 below |
| **v1.0.1 fixes (schema dialect, pre-flight range guard)** | **done, 90 tests pass, live-verified** |
| Reinstall `dist/hbsg-searchlight-1.0.1.mcpb` in Claude Desktop | not started (Justin double-clicks it) |
| Windows check by a teammate | not started |
| Tag `v1.0.1` pushed to origin | done, points at `3b20969` |
| GitHub Release v1.0.1 with the .mcpb attached | not started |
| **v1.1.0: strict-path fix, 2 compare tools, probe script, metric guide (2026-09-26)** | **done: merged to `main`, tag `v1.1.0`; 132 tests + pack pass; probe, smoke, and Claude Desktop verified 2026-09-28** |
| `npm run probe` and `npm run smoke` against the real API for 1.1.0 | done 2026-09-28 on Windows, both pass |

`v1.0.0` was tagged and released with its .mcpb attached (0 downloads). That build cannot run
any of the three export tools, so v1.0.1 should replace it as the latest release before
anyone is pointed at the repo.

## v1.0.1: two bugs found in real use (2026-09-02)

**1. All three export tools were uncallable.** Claude's client refused them with "has an
invalid outputSchema: JSON Schema declares an unsupported dialect". Root cause: MCP SDK 1.x
converts tool schemas with a hardcoded draft-07 target (`server/zod-json-schema-compat.ts`
passes no `target`; `mapMiniTarget` falls back to `draft-7`), and the client validates with
an Ajv 2020 instance that knows only 2020-12. Only the export tools declare an
`outputSchema`, which is why the other six worked. The SDK exposes no option to change the
target, so `src/schema-compat.ts` restamps the dialect on the way out of the transport and
rewrites the draft-07 tuple form (`items: [...]` plus `additionalItems`) that 2020-12 renamed.
Reproduced locally with `new Ajv2020().compile(schema)`, which throws
`no schema with key or ref "http://json-schema.org/draft-07/schema#"`.

**2. Over-90-day events requests burned API calls.** The typed events tools guarded the
attribution window client-side, but `searchlight_api_call` passed anything through, so each
attempt cost a real request against the per-user hourly limit. `SearchLightClient.preflight`
now refuses any `/api/<org>/events` request whose start-to-end span exceeds 90 days without
`interval=month|week|day`, before the key check and before the fetch. The raw tool's
description now states the rule as well.

Live verification (2026-09-02, against the real API through the built bundle):
all 9 tools compile under Ajv 2020; a real `searchlight_export_events_csv` call returns
`structuredContent` that validates against its own emitted `outputSchema`; the raw
over-window call is refused locally with no request sent. `npm run smoke` still passes.

### Live smoke results (2026-09-02, Justin's key, org `hoffmann-brothers`, 4 accounts)

- `/api`: 1 organization, 4 accounts, 121-field dictionary with `type`, `format`, `benchmarkable`.
- Events, 31 days by account: 4 rows in 7.8 s (SearchLight is slow per call; ~5 to 9 s is normal).
- Events with `["or","Organic","Advertising"]` filter: 8 rows, filter encoding confirmed.
- Events export, 6 months monthly by account and campaign: 1,579 rows, 144 KB, one call, 9.4 s.
- Benchmarks 2026-08: 6 series rows. Multi-month export Jun to Aug: 18 rows, 3 calls.
- Insights: **the live shape differs from the docs.** The endpoint returns a flat array of
  items with `kind` = `action_item` | `insight`, not per-account documents with nested
  `action_items`. `fields` selects item keys. `src/flatten.ts` was rewritten for the live
  shape (documented wrapper still handled). 29 items exported to a 25-column CSV.
- A deliberately heavy request (6 months, daily, by campaign/channel/zip/opportunityId) came
  back as a 49 MB JSON body in 12.8 s with no size rejection. So the "too many rows" 400 is
  rare; chunking remains a guard and `res.json()` on bodies that size is fine.
- 90-day rejection carries `code: "range-too-long"`; the client keys on it.
- The hourly rate limit was not reached across ~25 calls.

## Packaging regression found and fixed (2026-09-14)

`npm run pack` failed at "Checking archive contents": the archive held six files, not the
expected five. `AGENTS.md` was added in `11b68b5` / `2d77d90` but never added to
`.mcpbignore`, which still listed only `CLAUDE.md`, so agent guidance was being packed into
the shipped bundle. Fixed by adding `AGENTS.md` next to `CLAUDE.md` in `.mcpbignore`.

The expected-five-files guard in `scripts/pack.sh:32` is what caught it. Leave that list
strict; when a new top-level dev file appears, add it to `.mcpbignore` rather than widening
the guard. Any future `AGENTS.md`-style file needs the same treatment.

## Windows environment (2026-09-14)

Justin's Windows 11 clone at `C:\Users\justin.schmidt\HBSG Searchlight MCP`, Node v24.18.0,
npm 11.16.0. `npm install` warns that esbuild's postinstall is not in `allowScripts`; the
binary works anyway and the build is clean, so no action needed. Verified on Windows:
`npm run build`, 90/90 vitest, `npm run smoke`, and `npm run pack` (bundle runs from a clean
unpack, 9 tools in 360 ms).

This does not tick the "Windows check by a teammate" box below, which is about installing the
.mcpb in Claude Desktop, not about the repo toolchain.

## Live smoke re-run (2026-09-14, Justin's key, org `hoffmann-brothers`)

`SMOKE OK`, all 9 tools, on Windows against the real API. Calls were far faster than the
2026-09-02 Mac run (18 to 169 ms, versus 5 to 9 s), so the earlier "~5 to 9 s is normal" note
is not a floor; SearchLight latency varies a lot. Events export, 6 months monthly: 1,667 rows
/ 152.8 KB in one call. Benchmarks Jun to Aug: 18 rows, 3 calls. Insights: 26 items to a
26-row CSV. The three export tools work, so the v1.0.1 schema-dialect fix is confirmed
against the live API a second time.

## v1.1.0 (2026-09-26, cloud session, docs-only probe)

The cloud container had no key and its network policy blocked `searchlight.digital` and
`docs.searchlightdigital.io`, so the API was probed through its docs (fetched with a web
extraction service), not live. Findings:

- **2026-09-21 release note, "Strict organization paths" (breaking).** An account key in the
  path now returns 404 when the account is reached through an organization, and an
  `account`/`accounts` value outside the path's organization returns 404
  (`inaccessible-accounts`) instead of being dropped. `organizationArg` still advertised "an
  account key as a shortcut", so a model following it spent a request on a 404.
- Already handled: benchmarks `previous-mtd`, 503/504 retries, the insights 200-document cap.
- The metrics page gained "Interpreting the core metrics" (lag on closed revenue, ROAS on
  zero-spend channels, leads vs conversions, bookRate's unfiltered denominator, matchRate as
  data quality). It now feeds `METRIC_GUIDE` in `src/fields.ts`.

What shipped on the branch:

- `src/scope.ts` + `resolveScope` in `src/context.ts`: every typed tool checks organization and
  accounts against the cached `/api` before sending. An account key passed as organization is
  rerouted through its parent org with `account=` and a note; accounts outside the org and
  unknown orgs are refused locally. If `/api` itself fails, the request goes out unchecked.
  `searchlight_api_call` refuses (does not rewrite) an account-key path. Cost: one `/api` call
  per 10 minutes even when a default org is configured (previously none).
- `searchlight_compare_to_benchmark`: events for the month (by account, optional benchmark
  dimension) joined to the benchmark distribution, with a band and a direction-aware standing
  (`LOWER_IS_BETTER` in `src/fields.ts`). ROAS and cost metrics read "n/a (no spend)" at zero
  spend. 2 calls. Current month and `previous-mtd` use the local date for the events window;
  whether SearchLight's own MTD cutoff is today or yesterday is **unverified**.
- `searchlight_compare_periods`: one events query over two ranges (default: the preceding
  equal-length range), joined on dimensions with `m`, `m_prev`, `m_change`, `m_pct`. Metric vs
  dimension comes from the live dictionary, falling back to the bundled list.
- `searchlight_list_fields` prints metric caveats; the server instructions carry a summary.
- `npm run probe` (`scripts/probe.ts`): diffs the live dictionary and endpoint parameters
  against the bundled reference, records the strict-path 404s and three 400 error codes, and
  the live insights shape. About 8 requests; writes `smoke-output/probe-<date>.md`. Verified
  only against a local fake server.
- `npm run smoke` now also calls both compare tools and checks the account-key reroute.

## v1.1.0 live check (2026-09-28, Windows)

`npm run probe` passed (7 requests, report in `smoke-output/probe-2026-09-28.md`):

- Strict paths confirmed: an account key in the path returns 404 `inaccessible-organization`
  (not `inaccessible-accounts`); an account outside the org returns 404 `inaccessible-accounts`.
- 400 codes seen: `missing-metric`, `unknown-interval`, `missing-range`. Candidates for
  `SearchLightClient.preflight`.
- Live dictionary 121 fields vs 92 bundled; 29 live-only (e.g. `accountName`, `conversionType`,
  `source`, `campaignSpend`, `expectedValue`, Google Ads `clicks`/`impressions`/`cost`/
  `searchImpressionShare`). Nothing bundled is missing live, no type mismatches, benchmarks and
  endpoint parameters match. Dictionary entries now carry `preferredDirection`, which could
  replace the hand-kept `LOWER_IS_BETTER`.
- Insights: 27 flat items, kinds `action_item` and `insight`.

`npm run smoke` passed after one fix: benchmarks took 48 s for a single month when timed with
curl, so the smoke client's SDK-default 60 s request timeout tripped. `scripts/smoke.ts` now passes
`timeout: 300_000` to `callTool`. The 3-month benchmarks export took 90 s and 7 API calls
(retries on 503/504). Claude Desktop's own tool-call timeout has not been checked against this.

Compare tools checked by hand: `compare_to_benchmark` bands and direction are right
(avgCostPerLead above p75 reads "bottom 25%"); `compare_periods` defaults to the preceding
30 days; the `blue-sky-plumbing` reroute returns the same spend/leads as the org-level row.

### Field refresh and preflight (2026-09-28, same session)

- `src/fields.ts` now bundles all 121 live fields (probe re-run: "Live 121, bundled 121").
  Each metric carries the live `preferredDirection`; `LOWER_IS_BETTER` is derived from it,
  and `isLowerBetter` prefers the live dictionary's value when `/api` is cached. The live
  "down" set adds `avgConversionsPerLead`, `canceledCustomers`, `unbookableConversions`,
  `bookableUnbookedConversions` to the old hand-kept list.
- 10 dictionary metrics are on no endpoint's field list and the events endpoint's
  `missing-metric` error omits them: Google Ads `clicks`, `impressions`, `cost`,
  `allConversions`, `searchImpressionShare`, `searchLostIsBudget`, `searchLostIsRank`, plus
  `campaignSpend`, `expectedValue`, `opportunityAgents`. They are bundled with
  `dictionaryOnly: true`; `list_fields` shows "none (not queryable yet)" for them. Re-check
  in a later probe; they may be headed for a new endpoint.
- `INSIGHT_FIELDS` gained `client_slug`, `last_material_change`, `refreshed_this_run`.
- Preflight on events now also refuses a missing start or end, an unknown interval, and
  `fields` with no queryable metric (only when every name is in the bundled reference).
  `scripts/probe.ts` uses a client with preflight disabled so it still records the API's codes.

## Next actions, in order

0. v1.1.0 is done: Justin installed the 1.1.0 .mcpb in Claude Desktop on 2026-09-28 and both
   compare questions ("How did each account do against the industry last month?", "Compare
   last 30 days to the 30 before by campaign") worked. Fast-forwarded to `main`, tagged
   `v1.1.0`. Optional: a GitHub Release with `dist/hbsg-searchlight-1.1.0.mcpb` attached.
   Windows note: `npm run pack` needs Git Bash (PowerShell has no `bash` on PATH).

1. Justin installs `dist/hbsg-searchlight-1.0.1.mcpb` in Claude Desktop (replacing 1.0.0) and
   confirms `searchlight_export_events_csv` now runs, with the file landing in
   Documents/SearchLight Reports.
2. One Windows teammate installs and repeats step 1.
3. Tag: done. Remaining:
   `gh release create v1.0.1 dist/hbsg-searchlight-1.0.1.mcpb --title v1.0.1`.
   Note: `gh` is not installed on the Windows machine, so this needs a `gh` install or the
   GitHub web UI.
4. Re-pack before attaching a bundle to any release: any .mcpb packed from `11b68b5` up to
   the `.mcpbignore` fix in `b5117be` contains `AGENTS.md`. The v1.0.0 release bundle
   predates `AGENTS.md` and is unaffected.

## Ideas not built (YAGNI until asked)

- Sorting exported rows by start/account after a split (currently completion order; only
  matters when a split happens, which the smoke never triggered).
- Parsing `attributionDetail` into columns (gclid, utm_*, keyword, adGroup, trackingNumber) as
  an export option.
- A funnel/lead-quality report tool (customers by `adjustedType`, step rates, BNB by
  `conversionReasonLost`).
- MCP prompts for a monthly account review and a lead-quality review.

## Verified facts worth keeping

- SearchLight API docs: https://docs.searchlightdigital.io/api/overview/ (beta, 2026-08-17 latest note).
- Auth: `Authorization: <raw sl_ key>`, no Bearer. Responses gzip JSON. Errors `{error, code}`.
- Events `interval=total` over 90 days is rejected; month/week/day rows are independent so
  chunking at interval boundaries is exact.
- Claude Desktop 1.40609.1 on this Mac bundles Electron 42 (Node 24). Desktop does NOT expand
  `${DOCUMENTS}` in user_config defaults (found in the ServiceTitan bundle), so the server
  expands path tokens itself.
- MCP TypeScript SDK: using 1.30.0, not the 2.0.0 package split released 2026-07-27. 1.30.0
  is the newest 1.x, and it still emits draft-07 tool schemas; see the v1.0.1 note above.
- The API's own wording confirms the boundary: a 2026-06-01 to 2026-08-30 events request
  returns 400 "Requested range spans 91 days, exceeding the 90-day attribution window", so
  90 days inclusive is allowed and `MAX_INTERVAL_DAYS = 90` is right.

## Customer-level attribution detail (verified 2026-09-02)

There is no dedicated customer/lead endpoint. `/api/<org>/events` is the row-level source:
request `opportunityId` (the per-customer ID) plus `attributionDetail` and the grain collapses
to one row per event per customer.

`attributionDetail` is a newline-delimited text blob, not structured JSON. Verified contents on
a live St. Louis sample: `gclid`, `gbraid`, `gad_campaignid`, `utm_source/medium/campaign/
content/term`, `sts`/`stm`/`stc`/`stad`, `keyword`, `adGroup`, `campaignId`, `referrer`,
`referrerUrl`, `trackingNumber`, `campaignPhoneNumbers.0`, `category.name`, `medium`. Sections
are separated by `[from <resolver>]...` markers (`campaignMetrics`, `derived`, `location`,
`session`, `referrer`, `service-titan`, `service-titan-campaign`). Any parsing of gclid or utm
values has to be done client-side on that blob.

The `detail` dimension ("unstructured information about a lead from the source system") came
back absent on every row of that sample; do not rely on it.

`revenuePotential` is already deduplicated per customer per time period (last funnel step wins),
so grouping by `opportunityId` gives a correct per-customer number. Do not sum it across
overlapping groupings.

Volume: one account, one day, grouped by opportunityId/attributionDetail/campaign/sourceId
returned 1,974 rows in a single API call. Use `searchlight_export_events_csv` for anything
wider than a couple of days, and remember the 90-day attribution window.

## Spun out: Google Ads conversion export (2026-09-02)

Feeding SearchLight revenue to Google Ads as offline conversions is deliberately NOT part of
this extension. It lives in the sibling repo `../HBSG_SearchLight_Conversions`, design spec at
`docs/superpowers/specs/2026-09-02-searchlight-google-conversions-design.md`.

Reason: MCP tools exist so a model can choose arguments, and that job writes the signal the ad
account bids on, where the only remedy for a bad upload is filing retractions. It needs a
command with a config file and a dry run, not a tool call. Bundling would also force a new
.mcpb version and a teammate reinstall for every change to its value model.

Nothing in this repo changes as a result. The sibling repo carries its own thin SearchLight
client, with the 90-day preflight ported across on purpose.
