import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { SearchLightApiError, SearchLightConfigError } from "./client.js";
import type { Row } from "./csv.js";
import { DateError } from "./dates.js";
import { FilterError } from "./filters.js";

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownTable(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return "(no rows)";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => formatCell(r[c])).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

/** Columns in first-seen order across rows, with `preferred` first. */
export function inferColumns(rows: Row[], preferred: string[] = []): string[] {
  const set = new Set(preferred);
  for (const row of rows) for (const key of Object.keys(row)) set.add(key);
  return [...set];
}

export interface Limited<T> {
  rows: T[];
  total: number;
  truncated: boolean;
}

export function limitRows<T>(rows: T[], max: number): Limited<T> {
  return { rows: rows.slice(0, max), total: rows.length, truncated: rows.length > max };
}

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (structured) result.structuredContent = structured;
  return result;
}

export function describeError(err: unknown): string {
  if (err instanceof SearchLightApiError) return err.message;
  if (err instanceof SearchLightConfigError || err instanceof DateError || err instanceof FilterError) return err.message;
  if (err instanceof ZodError) {
    return `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function errorResult(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: describeError(err) }], isError: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
