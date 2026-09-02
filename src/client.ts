import { setTimeout as sleepFor } from "node:timers/promises";
import { DateError, eventsRangeViolation, isEventsPath } from "./dates.js";

export interface DictionaryEntry {
  displayName?: string;
  definition?: string;
  type?: "metric" | "dimension" | string;
  format?: string;
  benchmarkable?: boolean;
  [key: string]: unknown;
}

export interface EndpointInfo {
  endpoint: string;
  path: string;
  parameters?: string[];
  metrics?: string[];
  dimensions?: string[];
  [key: string]: unknown;
}

export interface OrganizationInfo {
  organization: string;
  accounts: string[];
  [key: string]: unknown;
}

/** Shape of `GET /api`. */
export interface AccessInfo {
  user: string;
  organizations: OrganizationInfo[];
  endpoints: EndpointInfo[];
  dictionary: Record<string, DictionaryEntry>;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export class SearchLightApiError extends Error {
  override name = "SearchLightApiError";
  constructor(
    readonly status: number,
    readonly apiMessage: string,
    readonly code: string | undefined,
    readonly hint: string,
    readonly url: string,
    readonly retryAfterSec?: number,
  ) {
    super(`SearchLight API ${status}: ${apiMessage}${hint ? ` ${hint}` : ""}`);
  }

  /** True when the API rejected the request for being too large and a smaller request would work. */
  isSizeLimit(): boolean {
    if (this.status === 504) return true;
    if (this.status !== 400) return false;
    if (this.isAttributionWindow()) return false;
    return /too many|too much|reduce|narrow|rows|documents|limit/i.test(this.apiMessage);
  }

  /** True when the range exceeded the 90-day window with interval=total. */
  isAttributionWindow(): boolean {
    return this.status === 400 && (this.code === "range-too-long" || /90-day/i.test(this.apiMessage));
  }
}

export class SearchLightConfigError extends Error {
  override name = "SearchLightConfigError";
}

export interface ClientOptions {
  apiKey: string | undefined;
  baseUrl: string;
  concurrency: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  accessTtlMs?: number;
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function hintFor(status: number, message: string, path: string): string {
  switch (status) {
    case 401:
      return "The API key was rejected. Check the key in Claude Desktop under Settings, Extensions, SearchLight, or generate a new one in the SearchLight app under Settings, API.";
    case 404:
      return `The organization in "${path}" is not accessible with this key. Call searchlight_list_access to see the organization and account keys you can use.`;
    case 429:
      return "SearchLight limits requests per user per hour. Wait for the hour to roll over before retrying; prefer fewer, larger requests.";
    case 503:
      return "Benchmark data for that month is still being gathered. Retry in a few minutes.";
    case 504:
      return "The request took too long. Use a shorter date range, fewer dimensions, or fewer metrics, or use an export tool which splits the request automatically.";
    case 400:
      if (/90-day/i.test(message)) {
        return "Ranges longer than 90 days need interval=month, week, or day. The export tools choose month automatically.";
      }
      return "";
    default:
      return "";
  }
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : text;
    const out: { message: string; code?: string } = { message: message || res.statusText || `HTTP ${res.status}` };
    if (typeof parsed.code === "string") out.code = parsed.code;
    return out;
  } catch {
    return { message: text.trim() || res.statusText || `HTTP ${res.status}` };
  }
}

export class SearchLightClient {
  readonly semaphore: Semaphore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly accessTtlMs: number;
  private accessCache: { value: AccessInfo; at: number } | undefined;
  private accessInflight: Promise<AccessInfo> | undefined;
  /** Requests actually sent to the API during this process, including retries. */
  requestCount = 0;

  constructor(private readonly opts: ClientOptions) {
    this.semaphore = new Semaphore(Math.max(1, opts.concurrency));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => sleepFor(ms));
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.accessTtlMs = opts.accessTtlMs ?? 10 * 60_000;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  buildUrl(path: string, params: QueryParams = {}): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(cleanPath, `${this.opts.baseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private requireKey(): string {
    if (!this.opts.apiKey) {
      throw new SearchLightConfigError(
        "No SearchLight API key is configured. Open Claude Desktop, Settings, Extensions, SearchLight and paste the key from the SearchLight app (Settings, API).",
      );
    }
    return this.opts.apiKey;
  }

  /**
   * Reject a request the API is certain to refuse, before it is sent. Runs
   * ahead of the key check so a malformed range is reported as such rather
   * than as a configuration problem.
   */
  private preflight(path: string, params: QueryParams): void {
    if (!isEventsPath(path)) return;
    const violation = eventsRangeViolation(params);
    if (violation) throw new DateError(violation);
  }

  /** GET a JSON endpoint with retries, rate-limit handling, and concurrency control. */
  async get<T = unknown>(path: string, params: QueryParams = {}): Promise<T> {
    this.preflight(path, params);
    const apiKey = this.requireKey();
    const url = this.buildUrl(path, params);
    return this.semaphore.run(async () => {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        this.requestCount += 1;
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method: "GET",
            headers: { Authorization: apiKey, Accept: "application/json", "Accept-Encoding": "gzip" },
            signal: AbortSignal.timeout(this.opts.timeoutMs),
          });
        } catch (err) {
          if (attempt < this.maxAttempts) {
            await this.sleep(backoffMs(attempt));
            continue;
          }
          const reason = err instanceof Error ? err.message : String(err);
          throw new SearchLightApiError(0, `Network error: ${reason}`, undefined, "Check the connection and retry.", url);
        }

        if (res.ok) {
          return (await res.json()) as T;
        }

        const { message, code } = await parseErrorBody(res);
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfter = retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : undefined;
        const error = new SearchLightApiError(res.status, message, code, hintFor(res.status, message, path), url, retryAfter);

        if (res.status === 429) {
          if (attempt === 1 && retryAfter !== undefined && retryAfter <= 60) {
            await this.sleep(retryAfter * 1000);
            continue;
          }
          throw error;
        }
        if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < this.maxAttempts) {
          await this.sleep(retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt));
          continue;
        }
        throw error;
      }
    });
  }

  /** `GET /api`, cached for a few minutes. */
  async getAccess(force = false): Promise<AccessInfo> {
    const now = Date.now();
    if (!force && this.accessCache && now - this.accessCache.at < this.accessTtlMs) {
      return this.accessCache.value;
    }
    if (!force && this.accessInflight) return this.accessInflight;
    this.accessInflight = this.get<AccessInfo>("/api")
      .then((value) => {
        this.accessCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        this.accessInflight = undefined;
      });
    return this.accessInflight;
  }

  /**
   * Pick the organization for a request: the explicit argument, then the
   * configured default, then the only accessible organization.
   */
  async resolveOrganization(explicit?: string, configuredDefault?: string): Promise<string> {
    const arg = explicit?.trim();
    if (arg) return arg;
    const def = configuredDefault?.trim();
    if (def) return def;
    const access = await this.getAccess();
    const orgs = access.organizations ?? [];
    if (orgs.length === 1 && orgs[0]) return orgs[0].organization;
    const names = orgs.map((o) => o.organization);
    throw new SearchLightConfigError(
      orgs.length === 0
        ? "This API key has no accessible organizations."
        : `Several organizations are accessible; pass organization explicitly. Options: ${names.join(", ")}.`,
    );
  }

  /** Account keys under an organization, or [] when the key names a single account. */
  async listAccounts(organization: string): Promise<string[]> {
    const access = await this.getAccess();
    const org = (access.organizations ?? []).find((o) => o.organization === organization);
    return org ? [...(org.accounts ?? [])] : [];
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** (attempt - 1));
}
