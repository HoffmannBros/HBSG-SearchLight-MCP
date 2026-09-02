# SearchLight for Claude Desktop

A Claude Desktop extension that connects Claude to the [SearchLight](https://searchlight.digital)
API for Hoffmann Brothers. Ask about spend, leads, revenue, ROAS, booking and match rates,
funnel steps, and lead grading, broken out by account, campaign, channel, business unit, or any
other SearchLight dimension. Compare against industry benchmarks, read SearchLight's
AI-generated insights, and export any query to a CSV file, however large.

Works on Windows and macOS. Nothing to install besides Claude Desktop; the extension runs on
the Node runtime that ships with Claude.

## Install (team members)

1. Get `hbsg-searchlight-<version>.mcpb` from Justin or from the
   [Releases page](https://github.com/HoffmannBros/HBSG-SearchLight-MCP/releases).
2. Double-click the file (or drag it into Claude Desktop, Settings, Extensions). Click Install.
3. Generate your own API key: sign in to the SearchLight app, open **Settings**, then **API**,
   and create a user key. It starts with `sl_`.
4. Paste the key into the **SearchLight API key** field. Optionally change the **Export
   folder** (default: `Documents/SearchLight Reports`) and set a **Default organization**.
5. Save. Start a new chat and try one of the prompts below.

Your key is stored in your operating system's keychain. You can only see the organizations
and accounts your own SearchLight login can see. Installing a newer `.mcpb` keeps your settings.

### Try it

```
What SearchLight organizations and accounts can I see?
Spend, leads, and cost per lead by account for last month.
ROAS by campaign for the last 90 days, Google Ads only.
Export the last 12 months of spend, leads, and revenue potential by account and month to CSV.
How does our booking rate compare to the industry for last month?
What are SearchLight's latest action items for our accounts?
```

## What Claude can do

| Tool | Purpose |
|---|---|
| `searchlight_list_access` | Organizations, account keys, endpoints, and the live field dictionary |
| `searchlight_list_fields` | Search dimensions and metrics by name, type, endpoint, or text |
| `searchlight_query_events` | Aggregate metrics by dimensions over a date range, with filters, inline |
| `searchlight_export_events_csv` | Same query written to CSV or JSONL, any size |
| `searchlight_get_benchmarks` | Industry benchmark and p10 to p90 range for one month |
| `searchlight_export_benchmarks_csv` | Benchmarks for many months in one file |
| `searchlight_get_insights` | AI-generated action items and insights, with priority, impact, and evidence |
| `searchlight_export_insights_csv` | Insight items flattened to CSV, or raw JSON |
| `searchlight_api_call` | Any SearchLight API path directly, for anything new |

All tools are read-only.

### Large exports

SearchLight limits each request: a single total covers at most 90 days, and requests that
span too many accounts, intervals, or rows are rejected. The export tools handle this
automatically. Ranges over 90 days default to monthly rows. When SearchLight rejects a request
as too large, the extension splits it by account (only when `account` or `accountKey` is one
of the requested fields, so aggregates keep their meaning) and then by date window, runs the
pieces in parallel, and streams the rows into one file. The result reports how many API calls
were used. SearchLight also enforces an hourly request limit per user; if you hit it, wait for
the hour to roll over.

CSV files are UTF-8 with a byte-order mark and CRLF line endings, so Excel opens them cleanly
on Windows. Existing files are never overwritten; a numeric suffix is added instead.

## Maintainers

### Develop

```bash
npm install
npm test            # build + unit tests + stdio handshake against the bundle
npm run inspect     # MCP Inspector against the built server
```

Copy `.env.example` to `.env`, add your key, then run the live smoke test, which exercises
every tool against the real API and writes files to `smoke-output/`:

```bash
npm run smoke
```

### Release

1. Bump `version` in `package.json`, `manifest.json`, and `src/version.ts` (they must match).
2. Run the pack script. It builds, validates the manifest, packs, checks that the archive holds
   exactly `manifest.json`, `package.json`, `server/index.cjs`, `icon.png`, and `README.md`,
   scans for `sl_` keys, and starts the bundle from a clean unpack.

   ```bash
   npm run pack
   ```

3. Commit, tag, and attach the bundle to a GitHub Release:

   ```bash
   git tag v1.0.0 && git push --tags
   gh release create v1.0.0 dist/hbsg-searchlight-1.0.0.mcpb --title "v1.0.0"
   ```

### How it is built

TypeScript on Node with the MCP TypeScript SDK 1.x and Zod. esbuild bundles everything into
`server/index.cjs`, so the `.mcpb` ships no `node_modules`. Claude Desktop runs it with its
bundled Node. Layout:

| Path | Role |
|---|---|
| `src/client.ts` | HTTP client: auth header, gzip, retries, rate-limit handling, error hints, access cache |
| `src/chunking.ts` | Split-on-rejection fetch engine for events and insights |
| `src/dates.ts` | Interval boundaries (calendar months, Monday weeks, days) and window halving |
| `src/csv.ts` | Streaming JSONL spool to CSV writer |
| `src/filters.ts` | Filter expression encoding |
| `src/fields.ts` | Bundled dimension and metric reference |
| `src/tools/` | The nine MCP tools |
| `scripts/pack.sh` | Release packaging with checks |

Configuration reaches the server as environment variables: `SEARCHLIGHT_API_KEY`,
`SEARCHLIGHT_OUTPUT_DIR`, `SEARCHLIGHT_DEFAULT_ORGANIZATION`, and optional
`SEARCHLIGHT_BASE_URL`, `SEARCHLIGHT_CONCURRENCY` (default 4), `SEARCHLIGHT_TIMEOUT_MS`.

API reference: <https://docs.searchlightdigital.io/api/overview/>. The API is in beta; if
SearchLight adds fields or parameters, `searchlight_api_call` and the live dictionary cover
them without a rebuild.
