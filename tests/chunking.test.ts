import { describe, expect, it } from "vitest";
import { SearchLightApiError, SearchLightClient } from "../src/client.js";
import { adaptiveFetch, eventsParams, fetchEventsChunked } from "../src/chunking.js";
import type { Row } from "../src/csv.js";

const access = {
  user: "me",
  organizations: [{ organization: "acme", accounts: ["a1", "a2", "a3"] }],
  endpoints: [],
  dictionary: {},
};

function tooBig(): Response {
  return new Response(JSON.stringify({ error: "Request would return too many rows; reduce accounts or intervals" }), {
    status: 400,
  });
}

/** A fake API that rejects any request wider than `maxDays` days or more than one account. */
function fakeApi(maxDays: number) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url.search);
    if (url.pathname === "/api") return new Response(JSON.stringify(access), { status: 200 });
    const p = url.searchParams;
    if (p.get("accounts")) return tooBig();
    if (!p.get("account")) return tooBig();
    const days = (Date.parse(p.get("end")!) - Date.parse(p.get("start")!)) / 86_400_000 + 1;
    if (days > maxDays) return tooBig();
    return new Response(
      JSON.stringify([{ account: p.get("account"), start: p.get("start"), end: p.get("end"), spend: days }]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function client(fetchImpl: typeof fetch) {
  return new SearchLightClient({
    apiKey: "sl_x",
    baseUrl: "https://example.test",
    concurrency: 3,
    timeoutMs: 1000,
    fetchImpl,
    sleep: async () => {},
  });
}

describe("fetchEventsChunked", () => {
  it("makes one call when the API accepts the whole request", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/acme/events");
      expect(url.searchParams.get("interval")).toBe("month");
      return new Response(JSON.stringify([{ spend: 1 }]), { status: 200 });
    }) as unknown as typeof fetch;
    const rows: Row[] = [];
    const stats = await fetchEventsChunked(
      client(fetchImpl),
      { organization: "acme", fields: ["spend"], start: "2026-01-01", end: "2026-06-30", interval: "month" },
      async (r) => {
        rows.push(...r);
      },
    );
    expect(stats).toEqual({ chunks: 1, splits: 0 });
    expect(rows).toEqual([{ spend: 1 }]);
  });

  it("splits by account, then by date window, until the API accepts", async () => {
    const { fetchImpl, seen } = fakeApi(70);
    const c = client(fetchImpl);
    const rows: Row[] = [];
    const stats = await fetchEventsChunked(
      c,
      { organization: "acme", fields: ["spend"], start: "2026-01-01", end: "2026-06-30", interval: "month" },
      async (r) => {
        rows.push(...r);
      },
    );
    // Jan-Jun (181 days) per account: halves to Jan-Mar (90) and Apr-Jun (91), both over 70,
    // so each halves again: Jan-Feb (59), Mar (31), Apr-May (61), Jun (30).
    expect(stats.chunks).toBe(12);
    expect(stats.splits).toBe(1 + 3 + 6);
    expect(rows).toHaveLength(12);
    const totalDays = rows.reduce((s, r) => s + (r.spend as number), 0);
    expect(totalDays).toBe(181 * 3);
    for (const a of ["a1", "a2", "a3"]) {
      const mine = rows.filter((r) => r.account === a).map((r) => `${r.start}..${r.end}`).sort();
      expect(mine).toEqual(["2026-01-01..2026-02-28", "2026-03-01..2026-03-31", "2026-04-01..2026-05-31", "2026-06-01..2026-06-30"]);
    }
    // One access lookup plus the events calls.
    expect(seen.filter((s) => s === "").length).toBe(1);
  });

  it("honours an explicit account list when splitting", async () => {
    const { fetchImpl } = fakeApi(400);
    const rows: Row[] = [];
    const stats = await fetchEventsChunked(
      client(fetchImpl),
      { organization: "acme", fields: ["spend"], start: "2026-01-01", end: "2026-01-31", interval: "total", accounts: ["a1", "a3"] },
      async (r) => {
        rows.push(...r);
      },
    );
    expect(stats).toEqual({ chunks: 2, splits: 1 });
    expect(rows.map((r) => r.account).sort()).toEqual(["a1", "a3"]);
  });

  it("rethrows when a single-interval, single-account request is still rejected", async () => {
    const { fetchImpl } = fakeApi(10);
    await expect(
      fetchEventsChunked(
        client(fetchImpl),
        { organization: "acme", fields: ["spend"], start: "2026-03-01", end: "2026-03-31", interval: "month", accounts: ["a1"] },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(SearchLightApiError);
  });

  it("does not split on non-size errors", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "Unknown field: bogus" }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      fetchEventsChunked(
        client(fetchImpl),
        { organization: "acme", fields: ["bogus"], start: "2026-01-01", end: "2026-01-31", interval: "total" },
        async () => {},
      ),
    ).rejects.toThrow(/Unknown field/);
    expect(calls).toBe(1);
  });
});

describe("eventsParams", () => {
  it("omits interval=total and picks account vs accounts", () => {
    const base = { organization: "o", fields: ["a", "spend"], start: "2026-01-01", end: "2026-01-31", interval: "total" as const };
    expect(eventsParams(base, { accounts: undefined, window: { start: "2026-01-01", end: "2026-01-31" } })).toEqual({
      fields: "a,spend",
      start: "2026-01-01",
      end: "2026-01-31",
      interval: undefined,
      account: undefined,
      accounts: undefined,
    });
    expect(
      eventsParams({ ...base, interval: "week", extraParams: { campaign: '["regex","x","i"]' } }, { accounts: ["k1", "k2"], window: { start: "2026-01-01", end: "2026-01-07" } }),
    ).toMatchObject({ interval: "week", accounts: "k1,k2", campaign: '["regex","x","i"]' });
  });
});

describe("adaptiveFetch", () => {
  it("counts chunks and splits", async () => {
    const stats = await adaptiveFetch<number>(
      { accounts: undefined, window: { start: "2026-01-01", end: "2026-01-02" } },
      {
        run: async (t) => {
          if (t.window.start === t.window.end) return 1;
          throw new SearchLightApiError(400, "too many rows", undefined, "", "u");
        },
        emit: async () => {},
        split: async (t) => [
          { accounts: undefined, window: { start: t.window.start, end: t.window.start } },
          { accounts: undefined, window: { start: t.window.end, end: t.window.end } },
        ],
      },
    );
    expect(stats).toEqual({ chunks: 2, splits: 1 });
  });
});
