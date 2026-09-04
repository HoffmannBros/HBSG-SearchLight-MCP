# HBSG SearchLight MCP

Claude Desktop extension (.mcpb) for the SearchLight API. TypeScript, Node, MCP SDK 1.x,
bundled by esbuild into `server/index.cjs` with no shipped node_modules.

## Commands

- `npm test` builds then runs vitest (unit tests plus a stdio handshake against the bundle).
- `npm run build` typechecks and bundles.
- `npm run smoke` runs the live API smoke test; needs `SEARCHLIGHT_API_KEY` in `.env`.
- `npm run pack` builds, validates, packs `dist/hbsg-searchlight-<version>.mcpb`, checks the
  archive contents, scans for secrets, and runs the bundle from a clean unpack.

## Rules

- Keep `version` identical in `package.json`, `manifest.json`, and `src/version.ts`.
- Never commit `.env`, `dist/`, `server/`, or `smoke-output/`. The pack script fails if an
  `sl_` key-shaped string is in the archive.
- Read `next_steps.md` first and update it before ending a session.
- API facts come from https://docs.searchlightdigital.io/api/overview/ (beta; re-verify
  before changing endpoint behavior). Design: `docs/superpowers/specs/`.
- Splitting an events request by account is only valid when `account` or `accountKey` is in
  `fields`; see `canSplitByAccount` in `src/chunking.ts`.
- `src/schema-compat.ts` restamps every tool schema as JSON Schema 2020-12 on the way out of
  the transport. MCP SDK 1.x hardcodes a draft-07 target and Claude's client validates with
  Ajv 2020, which refuses draft-07. Do not remove it, and do not introduce `definitions` or
  `dependencies` into a tool schema; `tests/server.test.ts` enforces both.
- Requests the API is certain to reject are refused in `SearchLightClient.preflight` before
  they are sent, because every rejection still counts against the hourly rate limit.
