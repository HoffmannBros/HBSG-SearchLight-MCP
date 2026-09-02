# next_steps.md

Handoff state for HBSG-SearchLight-MCP.

**Last updated:** 2026-09-02 (session 2, in progress)

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
| Repo scaffold (package.json, tsconfig, .gitignore, .mcpbignore, .env.example, icon, vitest) | done, uncommitted |
| `git init -b main`, remote `HoffmannBros/HBSG-SearchLight-MCP` | done, no commits yet |
| `npm install` | done |
| `src/config.ts` | written, untested |
| csv, filters, fields, chunking, client, tools, index | not started |
| manifest.json, README, scripts/pack.sh, scripts/smoke.ts | not started |
| Live smoke with Justin's key | blocked on key in `.env` |
| Push to GitHub | not started |

## Next actions, in order

1. Commit the scaffold.
2. TDD `config.ts`, `csv.ts`, `filters.ts`, `chunking.ts`, `client.ts`, then tools.
3. Manifest + pack script; `npm run pack`; unpack and handshake.
4. Ask Justin for the API key in `.env`, run `npm run smoke`, record results here.
5. Push, tag v1.0.0, attach `dist/hbsg-searchlight-1.0.0.mcpb` to a GitHub Release.

## Verified facts worth keeping

- SearchLight API docs: https://docs.searchlightdigital.io/api/overview/ (beta, 2026-08-17 latest note).
- Auth: `Authorization: <raw sl_ key>`, no Bearer. Responses gzip JSON. Errors `{error, code}`.
- Events `interval=total` over 90 days is rejected; month/week/day rows are independent so
  chunking at interval boundaries is exact.
- Claude Desktop 1.40609.1 on this Mac bundles Electron 42 (Node 24). Desktop does NOT expand
  `${DOCUMENTS}` in user_config defaults (found in the ServiceTitan bundle), so the server
  expands path tokens itself.
- MCP TypeScript SDK: using 1.30.0, not the 2.0.0 package split released 2026-07-27.
