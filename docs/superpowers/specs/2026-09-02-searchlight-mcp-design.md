# SearchLight MCP design

Date: 2026-09-02
Status: approved by Justin (plan mode), implementation in progress

## Goal

A Claude Desktop extension (.mcpb) that gives the Hoffmann Brothers team full access to the
SearchLight API from Claude, with CSV export of any query and automatic chunking for large
pulls. TypeScript on Node, one bundled file, no runtime installs for recipients. Windows and
macOS. Each person supplies their own SearchLight API key at install time.

Decisions made during brainstorming:
- Runtime: TypeScript on Node. Claude Desktop ships Node, so recipients install nothing and
  the server starts instantly.
- CSV scope: any events, benchmarks, or insights query. No parsing of UI saved-report URLs.
- Distribution: build locally with a pack script; attach the .mcpb to a GitHub Release.

## What the SearchLight API is (verified 2026-09-02 from docs.searchlightdigital.io)

Base URL `https://searchlight.digital`. Auth header `Authorization: <raw key>` (keys start with `sl_`, no Bearer prefix). All success responses are gzip JSON arrays or objects. Errors are JSON `{error, code}`. API is in beta.

| Endpoint | Purpose | Key params |
|---|---|---|
| `GET /api` | Access discovery: user, organizations with accounts, endpoints, field dictionary | none |
| `GET /api/<organization>/events` | Aggregated metrics by dimensions over a date range | `fields` (required, at least one metric), `start`, `end` (YYYY-MM-DD), `account`, `accounts`, `interval` (total, month, week, day), plus any field name as a filter |
| `GET /api/<organization>/benchmarks` | Industry benchmarks for one calendar month | `fields`, `month` (YYYY-MM or previous-mtd), `account`, `accounts`, filters on 4 dimensions only |
| `GET /api/<organization>/insights` | AI-generated insight documents | `account`, `accounts`, `start`+`end` (publication dates, both or neither), `fields` (document sections) |

Constraints that shape the design:
- Events: each interval must fit the 90-day attribution window. `interval=total` over more than 90 days is rejected with a 400. Longer ranges need `interval=month|week|day`, and rows are then tagged with `start`/`end`.
- Events: requests spanning too many accounts and intervals, or too many rows, get a 400 whose message says what to reduce.
- Benchmarks: one month per call. 503 means data still gathering.
- Insights: max 200 documents per call, else 400.
- Hourly per-user request limit, 429 when exceeded. 504 on slow requests.
- Filters: `field=value` or `field=<JSON expression>` such as `["or","a","b"]`, `["not",x]`, `["regex","pat","flags"]`, `["gte",n]`, `["empty"]`, `["notEmpty"]`, `["and",[...],[...]]`. Cross-field OR uses `filter=["or",{...},{...}]`. Values are URL-encoded.
- `<organization>` path segment accepts an organization key or an account key.

Full field references: dimensions at `/api/dimensions/`, metrics at `/api/metrics/`. The `/api` response also returns a live `dictionary` with display names, definitions, formats, and which metrics are benchmarkable.

## Architecture

Single stdio MCP server, TypeScript, bundled by esbuild into one CommonJS file with zero runtime dependencies shipped. Claude Desktop launches it with its bundled Node.

```
HBSG_SearchLight_MCP/
  manifest.json              MCPB manifest (v0.4, server.type node)
  package.json               private, scripts: build, test, pack, smoke
  tsconfig.json
  icon.png                   reuse the HBSG icon from hbsg_google_ads_mcp/icon.png
  README.md                  team install guide + maintainer build/release guide
  next_steps.md              handoff (per Justin's global CLAUDE.md)
  CLAUDE.md                  project conventions
  .gitignore  .mcpbignore  .env.example
  docs/superpowers/specs/2026-09-02-searchlight-mcp-design.md
  scripts/pack.sh            build, validate, pack, secret scan, version lockstep check
  scripts/smoke.ts           live smoke test using .env key
  src/
    index.ts                 McpServer + StdioServerTransport, registers tools
    config.ts                env parsing, path token expansion, defaults
    client.ts                SearchLightClient: fetch, gzip, retries, errors, concurrency, /api cache
    filters.ts               filter object -> query params (JSON encoding rules)
    chunking.ts              date window math + adaptive split-on-400 fetch engine
    csv.ts                   RFC 4180 writer, JSONL spool -> CSV two-pass export
    flatten.ts               insights document -> flat rows
    fields.ts                static dimension/metric reference (fallback when /api dictionary unavailable)
    tools/
      access.ts  events.ts  benchmarks.ts  insights.ts  raw.ts
    format.ts                inline result formatting, row caps, previews
  tests/                     vitest unit + mocked-fetch integration tests
  server/index.cjs           build output (gitignored, shipped in the bundle)
  dist/*.mcpb                pack output (gitignored)
```

### Dependencies

- `@modelcontextprotocol/sdk` 1.30.0 (chosen over 2.0.0, which shipped 2026-07-27 as a package split; 1.x remains maintained and is what the mcp-builder reference documents).
- `zod` 4.x (SDK peer range `^3.25 || ^4.0`).
- Dev: `typescript`, `esbuild`, `vitest`, `tsx`, `@anthropic-ai/mcpb`.
- HTTP via Node's built-in `fetch` (undici decompresses gzip automatically). No CSV library; the writer is about 40 lines.

### Configuration (env vars injected by the manifest)

| Env var | user_config | Notes |
|---|---|---|
| `SEARCHLIGHT_API_KEY` | `api_key`, string, sensitive, required | stored in OS keychain by Claude Desktop |
| `SEARCHLIGHT_OUTPUT_DIR` | `output_dir`, directory, default `${DOCUMENTS}/SearchLight Reports` | Claude Desktop does not expand `${DOCUMENTS}` in defaults (bug found in the ServiceTitan bundle), so `config.ts` expands `${HOME}`, `${DOCUMENTS}`, `${DESKTOP}`, `${DOWNLOADS}` itself, mirroring `service_titan_mcp/servicetitan_mcp/report_export.py:26` |
| `SEARCHLIGHT_DEFAULT_ORGANIZATION` | `default_organization`, string, optional | if blank, the server resolves the organization from `/api` when exactly one is accessible |
| `SEARCHLIGHT_BASE_URL`, `SEARCHLIGHT_CONCURRENCY` | none | env-only overrides for testing and tuning (defaults: production URL, 4) |

### Client layer (`src/client.ts`)

- `get(path, params)` builds the URL with `URLSearchParams`, sets `Authorization`, uses `AbortSignal.timeout` (120 s default).
- Retries: 502, 503, 504 and network errors with exponential backoff (3 attempts). 429: retry once only if `Retry-After` is 60 s or less, otherwise surface immediately with the hourly-limit explanation. 400, 401, 404 never retry.
- `SearchLightApiError { status, code, message, hint }` with actionable hints: 401 -> check the API key in the extension settings; 404 -> organization not accessible, call `searchlight_list_access`; 400 mentioning the 90-day window -> use an interval or the export tool.
- Semaphore limiting concurrent requests (default 4) so chunked exports run in parallel without tripping the rate limit.
- `/api` response cached in memory for 10 minutes; used for organization resolution and `searchlight_list_fields`.
- Per-session request counter reported by export tools so users can see how much of their hourly budget a big pull used.

### Filters (`src/filters.ts`)

Tool input `filters` is an object keyed by field name. String values pass through raw; arrays, objects, numbers, and booleans are JSON-encoded, matching the documented `attributionCategory=["or","Organic","Advertising"]` form. A separate `filter` input takes the cross-field expression array. Field names are validated against `^[A-Za-z0-9_]+$`; semantic validation is left to the API and its error is surfaced.

### Chunking engine (`src/chunking.ts`)

This is the "big chunks of data" piece. Rows for `interval=month|week|day` are computed independently per interval, so splitting a request at interval boundaries and concatenating the results is exact.

Events algorithm:
1. Validate: if the range exceeds 90 days and `interval` is `total`, refuse with a clear message (a true total over more than 90 days is not computable; suggest `month`). The export tool defaults `interval` to `month` for ranges over 90 days and says so in its result.
2. Try the whole request as one call.
3. On a 400 whose code or message indicates size (too many accounts/intervals/rows), or on a 504, split and recurse: first by account (one call per account, resolving the account list from `/api` when the request had none), then by date window aligned to the interval (month windows of 3 months, week windows of 12 weeks starting Monday, day windows of 90 days), halving windows down to a single interval. Non-size 400s are not retried.
4. Chunk results stream into the writer as they arrive; concurrency governed by the client semaphore.

Benchmarks: one call per requested month (list, or `start_month`..`end_month` range); rows gain a `month` column. Insights: one call, then split by account and by publication-date halves on the over-200 400.

Pure helpers (`dateWindows`, `alignToInterval`, `splitPlan`) have unit tests; the split-on-400 behavior is tested with a stubbed `fetch`.

### CSV pipeline (`src/csv.ts`)

Two streaming passes so memory stays bounded and the header is exact: rows spool to a JSONL temp file while the key set and order are collected (requested fields first, `start`/`end` and `month` up front, extras appended in first-seen order); then the JSONL is converted line by line to CSV. RFC 4180 quoting, CRLF line endings, UTF-8 with BOM by default so Excel on Windows opens it cleanly (`excel_bom` option). `format: "jsonl"` skips the second pass. Filenames are auto-generated (`events_<org>_<start>_<end>_<interval>.csv`) and sanitized like `report_export.py:_sanitize`; `filename` and `output_dir` overrides accepted; the target directory is created; existing files get a numeric suffix rather than being overwritten.

Insights flattening (`src/flatten.ts`): one row per action item or deep insight with `account, date, period, generated_at, confidence, graded_calls, section, title, summary, action, category, priority, impact_value, impact_unit, impact_display, takeaway`. Option to write the raw documents as JSON instead.

### Tool catalog (prefix `searchlight_`, all `readOnlyHint: true`, `openWorldHint: true`)

| Tool | Purpose |
|---|---|
| `searchlight_list_access` | Organizations, accounts, endpoints from `/api`; `include_dictionary` flag |
| `searchlight_list_fields` | Search the field dictionary by type, endpoint, or text; falls back to the bundled static reference |
| `searchlight_query_events` | Events query returned inline; `max_rows` cap (default 200, max 2000) with truncation notice and a pointer to the export tool |
| `searchlight_export_events_csv` | Same inputs plus file options; auto-chunks; returns path, row count, columns, bytes, API calls used, elapsed time, and a 5-row preview |
| `searchlight_get_benchmarks` | One month, inline |
| `searchlight_export_benchmarks_csv` | Many months stitched into one file |
| `searchlight_get_insights` | Insight documents inline (cap on documents) |
| `searchlight_export_insights_csv` | Flattened rows to CSV, or raw JSON |
| `searchlight_api_call` | Escape hatch: any path and params on the beta API, JSON result with inline cap |

Every tool takes an optional `organization`; resolution order is the argument, then the configured default, then the single accessible organization, else an error listing the choices. Tools return both text (compact markdown table or JSON) and `structuredContent` with an `outputSchema`.

### Manifest and packaging

`manifest.json` (manifest_version 0.4, same as Justin's other bundles): name `hbsg-searchlight`, display_name "SearchLight (Hoffmann Brothers)", `server.type: node`, `entry_point: server/index.cjs`, `mcp_config.command: node`, args `["${__dirname}/server/index.cjs"]`, env mapping the three user_config keys, `compatibility.platforms: ["darwin","win32"]`, `runtimes.node: ">=20"`, tools listed, repository pointing at the HoffmannBros repo, `long_description` with the key-generation steps (SearchLight app, Settings, API).

`scripts/pack.sh`: assert versions match in `package.json` and `manifest.json`; `npm run build` (tsc typecheck, then esbuild `--bundle --platform=node --target=node20 --format=cjs`); `mcpb validate manifest.json`; `mcpb pack . dist/hbsg-searchlight-<version>.mcpb`; list the archive and fail if it contains anything beyond `manifest.json`, `package.json`, `server/index.cjs`, `icon.png`, `README.md`; scan the archive for `sl_[A-Za-z0-9]{8,}` and `.env` content (same discipline as `hbsg_google_ads_mcp/build.sh`). `.mcpbignore` excludes `src/`, `tests/`, `node_modules/`, `docs/`, `scripts/`, `dist/`, `.env*`, `next_steps.md`, `CLAUDE.md`, `.claude/`, `tsconfig.json`.

Release flow documented in README: bump version in both files, run `npm run pack`, `git tag v<version>`, `gh release create v<version> dist/hbsg-searchlight-<version>.mcpb`. Team install: double-click the .mcpb, paste API key, optionally change the export folder. Reinstalling a newer bundle keeps settings.

### Repo bootstrap

`git init -b main`, add remote `https://github.com/HoffmannBros/HBSG-SearchLight-MCP.git`, commit in logical steps as work lands, push to main at the end (the repo is empty, so no pull is possible first; Justin's global rule to pull before work is satisfied by the verified-empty state).

## Implementation order

1. Repo scaffold: package.json, tsconfig, .gitignore, .mcpbignore, .env.example, git init + remote, design spec doc.
2. `config.ts` and `csv.ts` with unit tests (TDD; pure code, no network).
3. `filters.ts`, `fields.ts` static reference, `chunking.ts` window math with tests.
4. `client.ts` with mocked-fetch tests for retries, error mapping, gzip handling, concurrency.
5. Chunking fetch engine with split-on-400 tests.
6. Tools and `index.ts`; stdio handshake test that spawns the built server and asserts the nine tools.
7. `flatten.ts` for insights and its tests.
8. Manifest, icon, README, `scripts/pack.sh`; validate and pack.
9. Live smoke against the real API with Justin's key in `.env`: `/api`, a small events query, an export over more than 90 days that exercises chunking, benchmarks for the last month, latest insights. Record results in `next_steps.md`.
10. Push to GitHub, update `next_steps.md`, and hand Justin the `.mcpb` to install and try in Claude Desktop.

## Verification

- `npm test`: vitest suite (csv escaping, path expansion, filter encoding, window alignment, split-on-400, error hints, insights flattening).
- `npm run build` then a stdio handshake (`initialize`, `tools/list`) against `server/index.cjs` asserting tool names and schemas.
- `npx @modelcontextprotocol/inspector node server/index.cjs` for manual tool calls during development.
- `npm run smoke` with `SEARCHLIGHT_API_KEY` in `.env`: confirm real organizations come back, an events CSV lands in the output folder with the expected header and row count, and an export over more than 90 days completes with the reported chunk count.
- `npm run pack`: `mcpb validate` passes, archive contents are exactly the five expected files, secret scan is clean. Unpack to a temp dir and run `node server/index.cjs` handshake from there to prove the bundle is self-contained.
- Justin installs the .mcpb in Claude Desktop and runs "what SearchLight organizations can I see" and "export last 6 months of spend and leads by account to CSV".

## Risks and notes

- The API is beta; fields and responses may change. `searchlight_api_call` and the live `/api` dictionary keep the server useful without a rebuild.
- The hourly request limit is not published. Adaptive splitting only fans out when the API rejects a request, which keeps call counts minimal; the export result reports calls used.
- Windows Documents folders can be OneDrive-redirected; the output folder is user-configurable and reported in every export result.
- Node 24 is what Claude Desktop 1.40609.1 bundles (Electron 42); esbuild targets node20 so older Desktop builds still work.
