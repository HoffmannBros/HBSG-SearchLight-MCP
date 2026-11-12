# HBSG SearchLight MCP

Claude Desktop extension (.mcpb) for the SearchLight API. TypeScript, Node, MCP SDK 1.x,
bundled by esbuild into `server/index.cjs` with no shipped node_modules.

## Commands

- `npm test` builds, then runs vitest (unit tests plus a stdio handshake against the bundle).
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
  before changing endpoint behavior). Design notes live in `docs/superpowers/specs/`.
- Splitting an events request by account is only valid when `account` or `accountKey` is in
  `fields`; see `canSplitByAccount` in `src/chunking.ts`.
- `src/schema-compat.ts` restamps every tool schema as JSON Schema 2020-12 on the way out of
  the transport. MCP SDK 1.x hardcodes a draft-07 target and Claude's client validates with
  Ajv 2020, which refuses draft-07. Do not remove it, and do not introduce `definitions` or
  `dependencies` into a tool schema; `tests/server.test.ts` enforces both.
- `SearchLightClient.preflight` refuses requests the API is certain to reject before sending
  them, because every rejection still counts against the hourly rate limit.
- Typed tools get their organization and accounts from `resolveScope` (`src/context.ts`),
  never `resolveOrganization` alone. Since 2026-09-21 the API 404s an account key in the path
  unless that account is its own organization, and any account outside the path's org;
  `src/scope.ts` reroutes or refuses those locally. `subset` is checked against the
  organization's `subsets` from `GET /api` (an unknown subset 404s as
  `inaccessible-organization`). `-` means every account the key reaches; the API ignores
  `subset` with it, so it is refused locally.
- `src/guards.ts` holds the accuracy rules applied to events results. Each cites a dated
  measurement; do not remove or weaken one without re-measuring against the live API.
- Grading metrics and count metrics never go in one request (SearchLight measured `leads`
  ~20% high beside `gradedConversions`). Today this is a warning note only: Hoffmann accounts
  have no lead-grading data, so the split could not be verified (decision 2026-11-11).
- A campaign split under-reports spend (2.8% on one account-week, 2026-11-11). Totals come
  from an unsplit request; do not sum spend from campaign rows.
- Nothing outside `/api` is reachable with an `sl_` key (verified 2026-11-11). Do not add
  tools for the account configuration, provider health or cache routes.
- Ad-platform passthrough (Google Ads, Microsoft, Facebook, the ServiceTitan proxy) is out
  of scope by decision.
