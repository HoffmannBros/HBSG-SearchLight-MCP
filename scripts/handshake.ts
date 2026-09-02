/**
 * Start a built server bundle over stdio, list its tools, and print them.
 * Usage: tsx scripts/handshake.ts <path/to/index.cjs> [expected-tool-count]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bundle = process.argv[2];
const expected = process.argv[3] ? Number(process.argv[3]) : undefined;
if (!bundle) {
  console.error("usage: tsx scripts/handshake.ts <bundle.cjs> [expected-tool-count]");
  process.exit(2);
}

const started = Date.now();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bundle],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SEARCHLIGHT_API_KEY: "" },
  stderr: "pipe",
});
const client = new Client({ name: "handshake", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
const elapsed = Date.now() - started;
await client.close();
console.log(`${tools.length} tool(s) in ${elapsed} ms: ${tools.map((t) => t.name).join(", ")}`);
if (expected !== undefined && tools.length !== expected) {
  console.error(`expected ${expected} tools`);
  process.exit(1);
}
