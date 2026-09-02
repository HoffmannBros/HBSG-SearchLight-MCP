import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { DRAFT_07_ONLY_KEYWORDS, JSON_SCHEMA_DIALECT, normalizeToolSchemas, toDialect2020 } from "../src/schema-compat.js";

describe("toDialect2020", () => {
  it("restamps the draft-07 dialect the MCP SDK emits", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
    expect(toDialect2020(schema).$schema).toBe(JSON_SCHEMA_DIALECT);
  });

  it("stamps the dialect on a schema that declares none", () => {
    expect(toDialect2020({ type: "object" }).$schema).toBe(JSON_SCHEMA_DIALECT);
  });

  it("leaves the single-schema items form alone", () => {
    const out = toDialect2020({ type: "array", items: { type: "string" } });
    expect(out.items).toEqual({ type: "string" });
    expect(out).not.toHaveProperty("prefixItems");
  });

  it("rewrites the draft-07 tuple form to prefixItems, at any depth", () => {
    const out = toDialect2020({
      type: "object",
      properties: {
        pair: { type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: { type: "boolean" } },
      },
    }) as Record<string, any>;
    const pair = out.properties.pair;
    expect(pair.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
    expect(pair.items).toEqual({ type: "boolean" });
    expect(pair).not.toHaveProperty("additionalItems");
  });

  it("produces schemas an Ajv 2020 validator accepts", () => {
    const ajv = new Ajv2020({ strict: false });
    expect(() => ajv.compile(toDialect2020({ $schema: "http://json-schema.org/draft-07/schema#", type: "object" }))).not.toThrow();
  });
});

describe("normalizeToolSchemas", () => {
  it("rewrites both schemas on every tool in a tools/list result", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "a",
            inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
            outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
          },
          { name: "b", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } },
        ],
      },
    };
    normalizeToolSchemas(message);
    const tools = message.result.tools as Array<Record<string, any>>;
    expect(tools[0]!.inputSchema.$schema).toBe(JSON_SCHEMA_DIALECT);
    expect(tools[0]!.outputSchema.$schema).toBe(JSON_SCHEMA_DIALECT);
    expect(tools[1]!.inputSchema.$schema).toBe(JSON_SCHEMA_DIALECT);
    expect(tools[1]).not.toHaveProperty("outputSchema");
  });

  it("ignores messages that are not tools/list results", () => {
    const message = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } };
    expect(() => normalizeToolSchemas(message)).not.toThrow();
    expect(message.result).toEqual({ content: [{ type: "text", text: "hi" }] });
  });

  it("names the keywords the rewrite deliberately does not translate", () => {
    expect([...DRAFT_07_ONLY_KEYWORDS]).toEqual(["definitions", "dependencies"]);
  });
});
