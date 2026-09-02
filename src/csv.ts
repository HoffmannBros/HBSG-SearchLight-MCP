import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

export type Row = Record<string, unknown>;
export type ExportFormat = "csv" | "jsonl";

export interface FinalizeOptions {
  format: ExportFormat;
  /** Prefix a UTF-8 byte-order mark so Excel on Windows detects the encoding. */
  bom: boolean;
}

export interface ExportResult {
  path: string;
  rows: number;
  columns: string[];
  bytes: number;
}

const NEEDS_QUOTING = /[",\r\n]/;

/** Escape one value for an RFC 4180 CSV field. */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = String(value);
  } else if (typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else {
    text = JSON.stringify(value);
  }
  if (NEEDS_QUOTING.test(text) || text !== text.trim()) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvLine(values: unknown[]): string {
  return values.map(csvEscape).join(",");
}

/** Make an arbitrary string safe as a file name on Windows and macOS. */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return cleaned === "" ? "export" : cleaned;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Return `dir/filename`, or `dir/name-2.ext`, `-3`, ... if it already exists. */
export async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

async function writeWithBackpressure(stream: fs.WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

async function closeStream(stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

/**
 * Streams rows to a JSONL spool file while tracking the union of column
 * names, then converts the spool to the final CSV (or keeps it as JSONL).
 * Two streaming passes keep memory flat regardless of row count and let the
 * header include columns that only appear in later chunks.
 */
export class RowSpool {
  private readonly stream: fs.WriteStream;
  private readonly columnSet: Set<string>;
  private closed = false;
  rowCount = 0;

  private constructor(
    readonly dir: string,
    readonly spoolPath: string,
    initialColumns: string[],
  ) {
    this.columnSet = new Set(initialColumns);
    this.stream = fs.createWriteStream(spoolPath, { encoding: "utf8" });
  }

  static async create(opts: { dir: string; initialColumns: string[] }): Promise<RowSpool> {
    await fsp.mkdir(opts.dir, { recursive: true });
    const spoolPath = path.join(
      opts.dir,
      `.spool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl.tmp`,
    );
    return new RowSpool(opts.dir, spoolPath, opts.initialColumns);
  }

  columns(): string[] {
    return [...this.columnSet];
  }

  async push(row: Row): Promise<void> {
    for (const key of Object.keys(row)) this.columnSet.add(key);
    this.rowCount += 1;
    await writeWithBackpressure(this.stream, `${JSON.stringify(row)}\n`);
  }

  async pushMany(rows: Iterable<Row>): Promise<void> {
    for (const row of rows) await this.push(row);
  }

  /** Abandon the export and remove the spool file. */
  async discard(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.stream.destroy();
    }
    await fsp.rm(this.spoolPath, { force: true });
  }

  async finalize(filename: string, opts: FinalizeOptions): Promise<ExportResult> {
    this.closed = true;
    await closeStream(this.stream);
    const target = await uniquePath(this.dir, filename);
    const columns = this.columns();
    try {
      if (opts.format === "jsonl") {
        await fsp.rename(this.spoolPath, target);
      } else {
        await this.writeCsv(target, columns, opts.bom);
        await fsp.rm(this.spoolPath, { force: true });
      }
    } catch (err) {
      await fsp.rm(this.spoolPath, { force: true });
      throw err;
    }
    const stat = await fsp.stat(target);
    return { path: target, rows: this.rowCount, columns, bytes: stat.size };
  }

  private async writeCsv(target: string, columns: string[], bom: boolean): Promise<void> {
    const out = fs.createWriteStream(target, { encoding: "utf8" });
    try {
      await writeWithBackpressure(out, `${bom ? "\uFEFF" : ""}${csvLine(columns)}\r\n`);
      const input = fs.createReadStream(this.spoolPath, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        if (line === "") continue;
        const row = JSON.parse(line) as Row;
        await writeWithBackpressure(out, `${csvLine(columns.map((c) => row[c]))}\r\n`);
      }
    } finally {
      await closeStream(out);
    }
  }
}
