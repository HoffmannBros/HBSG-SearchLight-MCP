import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RowSpool, csvEscape, csvLine, sanitizeFilename, uniquePath } from "../src/csv.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sl-csv-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("csvEscape", () => {
  it("passes plain values through and stringifies numbers and booleans", () => {
    expect(csvEscape("abc")).toBe("abc");
    expect(csvEscape(12.5)).toBe("12.5");
    expect(csvEscape(true)).toBe("true");
  });

  it("renders null, undefined, and NaN as empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(Number.NaN)).toBe("");
  });

  it("quotes fields containing commas, quotes, or newlines and doubles quotes", () => {
    expect(csvEscape('Search - "Branded", 2026')).toBe('"Search - ""Branded"", 2026"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape(" padded ")).toBe('" padded "');
  });

  it("serializes objects and arrays as JSON", () => {
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvEscape([1, 2])).toBe('"[1,2]"');
    expect(csvEscape(["a"])).toBe('"[""a""]"');
  });
});

describe("csvLine", () => {
  it("joins escaped values with commas", () => {
    expect(csvLine(["a", 1, "x,y"])).toBe('a,1,"x,y"');
  });
});

describe("RowSpool", () => {
  it("writes a CSV with the initial columns first and extras appended in first-seen order", async () => {
    const spool = await RowSpool.create({ dir, initialColumns: ["account", "spend"] });
    await spool.push({ spend: 10, account: "A", leads: 3 });
    await spool.push({ account: "B", spend: 20.5, bookRate: 0.5, leads: 1 });
    const result = await spool.finalize("out.csv", { format: "csv", bom: false });
    expect(result.rows).toBe(2);
    expect(result.columns).toEqual(["account", "spend", "leads", "bookRate"]);
    const text = await fs.readFile(result.path, "utf8");
    expect(text).toBe("account,spend,leads,bookRate\r\nA,10,3,\r\nB,20.5,1,0.5\r\n");
    expect(result.bytes).toBe(Buffer.byteLength(text));
    const leftovers = (await fs.readdir(dir)).filter((f) => f.includes("spool"));
    expect(leftovers).toEqual([]);
  });

  it("prefixes a UTF-8 BOM when asked", async () => {
    const spool = await RowSpool.create({ dir, initialColumns: ["campaign"] });
    await spool.push({ campaign: "Ünïcode" });
    const result = await spool.finalize("bom.csv", { format: "csv", bom: true });
    const buf = await fs.readFile(result.path);
    expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buf.toString("utf8").slice(1)).toBe("campaign\r\nÜnïcode\r\n");
  });

  it("can keep the rows as JSONL", async () => {
    const spool = await RowSpool.create({ dir, initialColumns: [] });
    await spool.push({ a: 1 });
    await spool.push({ b: "two" });
    const result = await spool.finalize("rows.jsonl", { format: "jsonl", bom: false });
    const text = await fs.readFile(result.path, "utf8");
    expect(text).toBe('{"a":1}\n{"b":"two"}\n');
    expect(result.columns).toEqual(["a", "b"]);
  });

  it("writes an empty file with just the header when no rows arrive", async () => {
    const spool = await RowSpool.create({ dir, initialColumns: ["x", "y"] });
    const result = await spool.finalize("empty.csv", { format: "csv", bom: false });
    expect(await fs.readFile(result.path, "utf8")).toBe("x,y\r\n");
    expect(result.rows).toBe(0);
  });

  it("does not overwrite an existing file", async () => {
    await fs.writeFile(path.join(dir, "dup.csv"), "old");
    const spool = await RowSpool.create({ dir, initialColumns: ["a"] });
    await spool.push({ a: 1 });
    const result = await spool.finalize("dup.csv", { format: "csv", bom: false });
    expect(path.basename(result.path)).toBe("dup-2.csv");
    expect(await fs.readFile(path.join(dir, "dup.csv"), "utf8")).toBe("old");
  });

  it("handles many rows without losing any", async () => {
    const spool = await RowSpool.create({ dir, initialColumns: ["i", "text"] });
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      await spool.push({ i, text: `row ${i}, with "quotes"` });
    }
    const result = await spool.finalize("big.csv", { format: "csv", bom: false });
    expect(result.rows).toBe(n);
    const text = await fs.readFile(result.path, "utf8");
    expect(text.split("\r\n").length).toBe(n + 2);
  });
});

describe("uniquePath", () => {
  it("returns the plain path when free and numbered suffixes otherwise", async () => {
    expect(await uniquePath(dir, "a.csv")).toBe(path.join(dir, "a.csv"));
    await fs.writeFile(path.join(dir, "a.csv"), "");
    expect(await uniquePath(dir, "a.csv")).toBe(path.join(dir, "a-2.csv"));
    await fs.writeFile(path.join(dir, "a-2.csv"), "");
    expect(await uniquePath(dir, "a.csv")).toBe(path.join(dir, "a-3.csv"));
  });
});

describe("sanitizeFilename", () => {
  it("replaces anything outside a safe set with underscores and collapses runs", () => {
    expect(sanitizeFilename("events: hoffmann/stl 2026-01-01..2026-06-30")).toBe(
      "events_hoffmann_stl_2026-01-01..2026-06-30",
    );
    expect(sanitizeFilename("   ")).toBe("export");
  });
});
