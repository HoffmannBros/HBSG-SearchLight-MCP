# next_steps.md

Handoff state for HBSG-SearchLight-MCP.

**Last updated:** 2026-09-02

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
| Repo scaffold, git init, remote `HoffmannBros/HBSG-SearchLight-MCP` | done, pushed |
| config, csv spool, filters, dates, fields reference | done, 36 unit tests |
| API client (retries, 429 handling, hints, access cache, semaphore) | done, 15 tests |
| Adaptive chunking (account fan-out only when `account`/`accountKey` requested, then date halving) | done, 8 tests |
| Nine tools + server entry | done; stdio handshake test passes (9 tools, ~60 ms startup) |
| manifest.json (v0.4, node), README, CLAUDE.md, scripts/pack.sh, scripts/smoke.ts | done |
| `npm run pack` | passes: validate, archive = 5 files, secret scan, clean-unpack handshake; 268 KB |
| **Live smoke against the real API** | **BLOCKED: needs Justin's `sl_` key in `.env`** (copy `.env.example`) |
| Install in Claude Desktop and try | not started (Justin double-clicks `dist/hbsg-searchlight-1.0.0.mcpb`) |
| GitHub Release v1.0.0 with the .mcpb attached | not started; do after smoke passes |

## Next actions, in order

1. Justin: `cp .env.example .env`, paste the key, then `npm run smoke`. Fix anything the real
   API disagrees with (field names, error message wording for size rejections, insight shapes).
   Record the results here.
2. Justin installs `dist/hbsg-searchlight-1.0.0.mcpb`, tries "what SearchLight organizations
   can I see" and a 6-month CSV export. Confirm the export lands in Documents/SearchLight Reports
   on macOS; get one Windows teammate to confirm the same.
3. `git tag v1.0.0`, `gh release create v1.0.0 dist/hbsg-searchlight-1.0.0.mcpb`.

## Known unknowns to verify in the smoke

- Exact wording and `code` of the size-rejection 400 (chunking keys on
  /too many|too much|reduce|narrow|rows|documents|limit/ in `SearchLightApiError.isSizeLimit`).
- Whether `/api` `dictionary` entries carry `type`, `format`, `benchmarkable` as documented.
- Insight document shape beyond the documented sections.
- The icon is 512x512 already; the validator's note is informational.

## Verified facts worth keeping

- SearchLight API docs: https://docs.searchlightdigital.io/api/overview/ (beta, 2026-08-17 latest note).
- Auth: `Authorization: <raw sl_ key>`, no Bearer. Responses gzip JSON. Errors `{error, code}`.
- Events `interval=total` over 90 days is rejected; month/week/day rows are independent so
  chunking at interval boundaries is exact.
- Claude Desktop 1.40609.1 on this Mac bundles Electron 42 (Node 24). Desktop does NOT expand
  `${DOCUMENTS}` in user_config defaults (found in the ServiceTitan bundle), so the server
  expands path tokens itself.
- MCP TypeScript SDK: using 1.30.0, not the 2.0.0 package split released 2026-07-27.
