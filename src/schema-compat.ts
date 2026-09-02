/**
 * JSON Schema dialect compatibility for the tool schemas we publish.
 *
 * MCP TypeScript SDK 1.x converts every `inputSchema` and `outputSchema` with a
 * hardcoded draft-07 target (`server/zod-json-schema-compat.ts` passes no
 * `target`, and its `mapMiniTarget` falls back to `draft-7`), so each schema
 * goes out stamped `"$schema": "http://json-schema.org/draft-07/schema#"`.
 *
 * Claude's MCP client validates a tool's declared schemas with an Ajv 2020
 * instance, which knows only the 2020-12 dialect. It therefore refuses to call
 * any tool that declares draft-07:
 *
 *   Tool 'searchlight_export_events_csv' has an invalid outputSchema: JSON
 *   Schema declares an unsupported dialect ("$schema":
 *   "http://json-schema.org/draft-07/schema#"). The default validator supports
 *   JSON Schema 2020-12 only.
 *
 * Observed 2026-09-02: it broke all three `*_export_*_csv` tools, the only ones
 * that declare an outputSchema. The SDK exposes no option to change the target,
 * so we restamp the dialect on the way out of the transport.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Draft-07 keywords that 2020-12 renamed and that `toDialect2020` deliberately
 * does NOT translate, because doing so correctly means rewriting `$ref`
 * targets. Zod only emits them for recursive or `dependentRequired`-style
 * schemas, which none of our tools use; `tests/server.test.ts` fails if one
 * ever appears, rather than letting the restamp silently change its meaning.
 */
export const DRAFT_07_ONLY_KEYWORDS = ["definitions", "dependencies"] as const;

export type Schema = Record<string, unknown>;

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite the draft-07 tuple form, the one construct zod emits whose meaning
 * changes between dialects: draft-07 `items: [A, B]` plus `additionalItems: C`
 * is 2020-12 `prefixItems: [A, B]` plus `items: C`. Under 2020-12 an untouched
 * `items: [A, B]` would be read as a single subschema and silently reject
 * everything.
 */
function rewriteTupleForm(node: Schema): void {
  if (Array.isArray(node.items)) {
    node.prefixItems = node.items;
    delete node.items;
    if ("additionalItems" in node) {
      node.items = node.additionalItems;
      delete node.additionalItems;
    }
  }
}

function walk(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item);
    return;
  }
  if (!isPlainObject(node)) return;
  rewriteTupleForm(node);
  for (const value of Object.values(node)) walk(value);
}

/** Restamp a JSON Schema as 2020-12, in place, and return it. */
export function toDialect2020(schema: Schema): Schema {
  walk(schema);
  schema.$schema = JSON_SCHEMA_DIALECT;
  return schema;
}

/**
 * Restamp the schemas of every tool in a `tools/list` result. Anything that is
 * not such a result passes through untouched.
 */
export function normalizeToolSchemas(message: unknown): void {
  if (!isPlainObject(message)) return;
  const result = message.result;
  if (!isPlainObject(result) || !Array.isArray(result.tools)) return;
  for (const tool of result.tools) {
    if (!isPlainObject(tool)) continue;
    for (const key of ["inputSchema", "outputSchema"] as const) {
      const schema = tool[key];
      if (isPlainObject(schema)) toDialect2020(schema);
    }
  }
}

/**
 * Wrap a transport so every outgoing message gets its tool schemas restamped.
 * Applied at the transport rather than at the request handler because the SDK
 * installs the `tools/list` handler itself and offers no hook to post-process
 * it.
 */
export function withSchemaCompat<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    normalizeToolSchemas(message);
    return send(message, options);
  };
  return transport;
}
