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
| Repo, scaffold, remote `HoffmannBros/HBSG-SearchLight-MCP` | done, pushed |
| config, csv spool, filters, dates, fields reference, client, chunking, 9 tools | done, 68 tests pass (`npm test`) |
| manifest.json (v0.4, node), README, CLAUDE.md, scripts/pack.sh, scripts/smoke.ts | done |
| `npm run pack` | passes; `dist/hbsg-searchlight-1.0.0.mcpb`, 268 KB, starts in ~60 ms |
| **Live smoke against the real API (2026-09-02)** | **PASSED**: all 9 tools; see below |
| Install in Claude Desktop and try | not started (Justin double-clicks the .mcpb) |
| Windows check by a teammate | not started |
| GitHub Release v1.0.0 with the .mcpb attached | not started |

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

## Next actions, in order

1. Justin installs `dist/hbsg-searchlight-1.0.0.mcpb` in Claude Desktop, tries "what
   SearchLight organizations can I see" and a 6-month CSV export; confirm the file lands in
   Documents/SearchLight Reports.
2. One Windows teammate installs and repeats step 1.
3. `git tag v1.0.0 && git push --tags`, then
   `gh release create v1.0.0 dist/hbsg-searchlight-1.0.0.mcpb --title v1.0.0`.

## Ideas not built (YAGNI until asked)

- Sorting exported rows by start/account after a split (currently completion order; only
  matters when a split happens, which the smoke never triggered).
- A `searchlight_compare_to_benchmark` workflow tool that runs events and benchmarks together.

## Verified facts worth keeping

- SearchLight API docs: https://docs.searchlightdigital.io/api/overview/ (beta, 2026-08-17 latest note).
- Auth: `Authorization: <raw sl_ key>`, no Bearer. Responses gzip JSON. Errors `{error, code}`.
- Events `interval=total` over 90 days is rejected; month/week/day rows are independent so
  chunking at interval boundaries is exact.
- Claude Desktop 1.40609.1 on this Mac bundles Electron 42 (Node 24). Desktop does NOT expand
  `${DOCUMENTS}` in user_config defaults (found in the ServiceTitan bundle), so the server
  expands path tokens itself.
- MCP TypeScript SDK: using 1.30.0, not the 2.0.0 package split released 2026-07-27.
