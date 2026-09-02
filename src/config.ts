import os from "node:os";
import path from "node:path";

export interface Config {
  /** Raw SearchLight user key (starts with sl_). Undefined when not configured. */
  apiKey: string | undefined;
  baseUrl: string;
  outputDir: string;
  defaultOrganization: string | undefined;
  concurrency: number;
  timeoutMs: number;
}

export const DEFAULT_BASE_URL = "https://searchlight.digital";
export const DEFAULT_OUTPUT_DIR = "${DOCUMENTS}/SearchLight Reports";

/**
 * Expand the MCPB path placeholders ourselves. Claude Desktop passes
 * user_config defaults such as "${DOCUMENTS}/..." through literally
 * (observed on the ServiceTitan bundle), so the server must resolve them.
 */
export function expandPathTokens(raw: string, home: string = os.homedir()): string {
  const replacements: Array<[string, string]> = [
    ["${HOME}", home],
    ["${DOCUMENTS}", path.join(home, "Documents")],
    ["${DESKTOP}", path.join(home, "Desktop")],
    ["${DOWNLOADS}", path.join(home, "Downloads")],
  ];
  let out = raw.trim();
  for (const [token, value] of replacements) {
    out = out.split(token).join(value);
  }
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(home, out.slice(1));
  }
  return path.resolve(out);
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Config {
  return {
    apiKey: blankToUndefined(env.SEARCHLIGHT_API_KEY),
    baseUrl: (blankToUndefined(env.SEARCHLIGHT_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    outputDir: expandPathTokens(blankToUndefined(env.SEARCHLIGHT_OUTPUT_DIR) ?? DEFAULT_OUTPUT_DIR, home),
    defaultOrganization: blankToUndefined(env.SEARCHLIGHT_DEFAULT_ORGANIZATION),
    concurrency: positiveInt(env.SEARCHLIGHT_CONCURRENCY, 4),
    timeoutMs: positiveInt(env.SEARCHLIGHT_TIMEOUT_MS, 120_000),
  };
}
