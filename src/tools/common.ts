import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { expandPathTokens } from "../config.js";
import { errorResult } from "../format.js";
import { INTERVALS } from "../dates.js";

export const organizationArg = z
  .string()
  .optional()
  .describe(
    "Organization key, or an account key as a shortcut. Omit to use the configured default, or the only organization this key can reach. Call searchlight_list_access to see the options.",
  );

export const accountArg = z.string().optional().describe("Restrict to one account key.");
export const accountsArg = z.array(z.string()).optional().describe("Restrict to these account keys.");

export const fieldsArg = z
  .array(z.string().min(1))
  .min(1)
  .describe(
    "Dimensions and metrics to return, in output order. Must include at least one metric, e.g. [\"account\",\"campaign\",\"spend\",\"leads\"]. Use searchlight_list_fields to discover names.",
  );

export const dateArg = (label: string) => z.string().describe(`${label} date, YYYY-MM-DD.`);

export const intervalArg = z
  .enum(INTERVALS)
  .optional()
  .describe(
    "total (one row set for the whole range), or month, week, day (metrics computed per interval, rows tagged with start/end). Ranges over 90 days require month, week, or day; the default is total up to 90 days and month beyond that.",
  );

export const filtersArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    'Filters keyed by field name. A string means equality (e.g. {"adjustedType":"closed"}). An array is an expression: ["or","Organic","Advertising"], ["not","Organic"], ["regex","gmb|gbp","ui"], ["gte",1000], ["lte","2026-05-01"], ["empty"], ["notEmpty"], ["and",["gte",100],["lte",500]]. Different fields combine with AND.',
  );

export const crossFilterArg = z
  .array(z.unknown())
  .optional()
  .describe('Cross-field expression, e.g. ["or",{"attributionCategory":"Advertising"},{"total":["gte",50000]}].');

export const outputDirArg = z
  .string()
  .optional()
  .describe("Folder to write into. Defaults to the configured export folder. Supports ${HOME}, ${DOCUMENTS}, ${DESKTOP}, ${DOWNLOADS}.");

export const filenameArg = z
  .string()
  .optional()
  .describe("File name (extension optional). Defaults to a descriptive name. Existing files are never overwritten; a numeric suffix is added.");

export const formatArg = z.enum(["csv", "jsonl"]).default("csv").describe("csv (default) or jsonl (one JSON object per line).");
export const bomArg = z.boolean().default(true).describe("Prefix a UTF-8 BOM so Excel on Windows opens the CSV correctly. Default true.");
export const previewRowsArg = z.number().int().min(0).max(50).default(5).describe("Rows to echo back as a preview. Default 5.");

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function pickAccounts(account?: string, accounts?: string[]): string[] | undefined {
  const list = [...(accounts ?? []), ...(account ? [account] : [])].map((a) => a.trim()).filter(Boolean);
  return list.length > 0 ? [...new Set(list)] : undefined;
}

export function resolveOutputDir(ctx: AppContext, override?: string): string {
  return override && override.trim() ? expandPathTokens(override) : ctx.config.outputDir;
}

export function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Wrap a handler so thrown errors become isError results with useful text. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
