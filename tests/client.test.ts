import { describe, expect, it, vi } from "vitest";
import { SearchLightApiError, SearchLightClient, SearchLightConfigError, Semaphore } from "../src/client.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(handler: Handler, overrides: Partial<ConstructorParameters<typeof SearchLightClient>[0]> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const client = new SearchLightClient({
    apiKey: "sl_test",
    baseUrl: "https://example.test",
    concurrency: 2,
    timeoutMs: 5000,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { client, calls, sleeps };
}

describe("SearchLightClient.get", () => {
  it("sends the raw key in Authorization and encodes params", async () => {
    const { client, calls } = makeClient(() => jsonResponse([{ spend: 1 }]));
    const data = await client.get("/api/acme/events", { fields: "spend", start: "2026-05-01", end: undefined, interval: "week" });
    expect(data).toEqual([{ spend: 1 }]);
    expect(calls[0]?.url).toBe("https://example.test/api/acme/events?fields=spend&start=2026-05-01&interval=week");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("sl_test");
    expect(client.requestCount).toBe(1);
  });

  it("refuses to run without a key", async () => {
    const { client } = makeClient(() => jsonResponse({}), { apiKey: undefined });
    await expect(client.get("/api")).rejects.toBeInstanceOf(SearchLightConfigError);
  });

  it("surfaces API errors with the message, code, and a hint", async () => {
    const { client } = makeClient(() => jsonResponse({ error: "Missing or invalid API key", code: "unauthorized" }, 401));
    const err = await client.get("/api").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchLightApiError);
    const apiErr = err as SearchLightApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe("unauthorized");
    expect(apiErr.hint).toMatch(/Settings/);
    expect(apiErr.message).toContain("Missing or invalid API key");
  });

  it("retries 502 with backoff and then succeeds", async () => {
    let n = 0;
    const { client, sleeps } = makeClient(() => (++n < 3 ? jsonResponse({ error: "upstream" }, 502) : jsonResponse({ ok: true })));
    expect(await client.get("/api")).toEqual({ ok: true });
    expect(n).toBe(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(client.requestCount).toBe(3);
  });

  it("gives up after maxAttempts on persistent 503", async () => {
    const { client } = makeClient(() => jsonResponse({ error: "still gathering" }, 503));
    const err = (await client.get("/api/acme/benchmarks").catch((e: unknown) => e)) as SearchLightApiError;
    expect(err.status).toBe(503);
    expect(err.hint).toMatch(/few minutes/);
    expect(client.requestCount).toBe(3);
  });

  it("retries a 429 once when Retry-After is short, otherwise throws immediately", async () => {
    let n = 0;
    const short = makeClient(() =>
      ++n === 1 ? jsonResponse({ error: "rate" }, 429, { "retry-after": "5" }) : jsonResponse({ ok: 1 }),
    );
    expect(await short.client.get("/api")).toEqual({ ok: 1 });
    expect(short.sleeps).toEqual([5000]);

    const long = makeClient(() => jsonResponse({ error: "Hourly request limit reached" }, 429));
    const err = (await long.client.get("/api").catch((e: unknown) => e)) as SearchLightApiError;
    expect(err.status).toBe(429);
    expect(long.client.requestCount).toBe(1);
    expect(err.hint).toMatch(/hour/);
  });

  it("does not retry 400 or 404", async () => {
    const { client } = makeClient(() => jsonResponse({ error: "Unknown organization" }, 404));
    const err = (await client.get("/api/nope/events").catch((e: unknown) => e)) as SearchLightApiError;
    expect(err.status).toBe(404);
    expect(err.hint).toMatch(/searchlight_list_access/);
    expect(client.requestCount).toBe(1);
  });

  it("handles a non-JSON error body", async () => {
    const { client } = makeClient(() => new Response("Bad Gateway", { status: 400 }));
    const err = (await client.get("/api").catch((e: unknown) => e)) as SearchLightApiError;
    expect(err.apiMessage).toBe("Bad Gateway");
  });

  it("retries network failures", async () => {
    let n = 0;
    const { client } = makeClient(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    });
    expect(await client.get("/api")).toEqual({ ok: true });
  });
});

describe("SearchLightApiError classification", () => {
  const mk = (status: number, msg: string) => new SearchLightApiError(status, msg, undefined, "", "u");
  it("recognizes size-limit rejections and the 90-day window", () => {
    expect(mk(400, "Request would return too many rows. Reduce the number of accounts or intervals.").isSizeLimit()).toBe(true);
    expect(mk(504, "timeout").isSizeLimit()).toBe(true);
    expect(mk(400, "Requested range spans 120 days, exceeding the 90-day attribution window.").isSizeLimit()).toBe(false);
    expect(mk(400, "Requested range spans 120 days, exceeding the 90-day attribution window.").isAttributionWindow()).toBe(true);
    expect(mk(400, "Unknown field foo").isSizeLimit()).toBe(false);
    expect(mk(401, "nope").isSizeLimit()).toBe(false);
  });
});

describe("access and organization resolution", () => {
  const access = {
    user: "me@example.com",
    organizations: [
      { organization: "acme-group", accounts: ["acme-hvac", "acme-plumbing"] },
      { organization: "other", accounts: ["other-1"] },
    ],
    endpoints: [],
    dictionary: {},
  };

  it("caches GET /api and de-duplicates concurrent calls", async () => {
    const { client } = makeClient(() => jsonResponse(access));
    const [a, b] = await Promise.all([client.getAccess(), client.getAccess()]);
    expect(a).toBe(b);
    await client.getAccess();
    expect(client.requestCount).toBe(1);
    await client.getAccess(true);
    expect(client.requestCount).toBe(2);
  });

  it("prefers the explicit argument, then the configured default, then the only organization", async () => {
    const { client } = makeClient(() => jsonResponse({ ...access, organizations: [access.organizations[0]] }));
    expect(await client.resolveOrganization("x", "y")).toBe("x");
    expect(await client.resolveOrganization("  ", "y")).toBe("y");
    expect(await client.resolveOrganization(undefined, "")).toBe("acme-group");
  });

  it("errors with the options when several organizations exist", async () => {
    const { client } = makeClient(() => jsonResponse(access));
    await expect(client.resolveOrganization()).rejects.toThrow(/acme-group, other/);
  });

  it("lists accounts for an organization and [] for an account key", async () => {
    const { client } = makeClient(() => jsonResponse(access));
    expect(await client.listAccounts("acme-group")).toEqual(["acme-hvac", "acme-plumbing"]);
    expect(await client.listAccounts("acme-hvac")).toEqual([]);
  });
});

describe("Semaphore", () => {
  it("never exceeds its limit", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
