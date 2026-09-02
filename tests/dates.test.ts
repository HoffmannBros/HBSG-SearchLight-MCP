import { describe, expect, it } from "vitest";
import {
  DateError,
  daysInclusive,
  eventsRangeViolation,
  halveWindow,
  isEventsPath,
  intervalBoundaries,
  monthRange,
  parseIsoDate,
} from "../src/dates.js";

describe("parseIsoDate / daysInclusive", () => {
  it("rejects malformed and impossible dates", () => {
    expect(() => parseIsoDate("2026/01/01")).toThrow(DateError);
    expect(() => parseIsoDate("2026-02-30")).toThrow(/real calendar date/);
  });

  it("counts inclusive days, including across a leap day", () => {
    expect(daysInclusive("2026-05-01", "2026-05-31")).toBe(31);
    expect(daysInclusive("2028-02-28", "2028-03-01")).toBe(3);
    expect(daysInclusive("2026-01-01", "2026-03-31")).toBe(90);
    expect(() => daysInclusive("2026-02-01", "2026-01-01")).toThrow(DateError);
  });
});

describe("intervalBoundaries", () => {
  it("returns the range itself for total", () => {
    expect(intervalBoundaries("2026-01-15", "2026-02-10", "total")).toEqual([
      { start: "2026-01-15", end: "2026-02-10" },
    ]);
  });

  it("clips calendar months to the requested range", () => {
    expect(intervalBoundaries("2026-01-15", "2026-03-10", "month")).toEqual([
      { start: "2026-01-15", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-10" },
    ]);
  });

  it("uses Monday-start weeks with partial edges", () => {
    // 2026-05-01 is a Friday; 2026-05-04 is the next Monday.
    expect(intervalBoundaries("2026-05-01", "2026-05-12", "week")).toEqual([
      { start: "2026-05-01", end: "2026-05-03" },
      { start: "2026-05-04", end: "2026-05-10" },
      { start: "2026-05-11", end: "2026-05-12" },
    ]);
  });

  it("yields one window per day for day", () => {
    expect(intervalBoundaries("2026-12-30", "2027-01-01", "day")).toEqual([
      { start: "2026-12-30", end: "2026-12-30" },
      { start: "2026-12-31", end: "2026-12-31" },
      { start: "2027-01-01", end: "2027-01-01" },
    ]);
  });
});

describe("halveWindow", () => {
  it("splits at an interval boundary near the middle", () => {
    expect(halveWindow({ start: "2026-01-15", end: "2026-06-30" }, "month")).toEqual([
      { start: "2026-01-15", end: "2026-03-31" },
      { start: "2026-04-01", end: "2026-06-30" },
    ]);
    expect(halveWindow({ start: "2026-05-01", end: "2026-05-12" }, "week")).toEqual([
      { start: "2026-05-01", end: "2026-05-10" },
      { start: "2026-05-11", end: "2026-05-12" },
    ]);
  });

  it("returns null when the window is a single interval or total", () => {
    expect(halveWindow({ start: "2026-03-01", end: "2026-03-31" }, "month")).toBeNull();
    expect(halveWindow({ start: "2026-03-05", end: "2026-03-05" }, "day")).toBeNull();
    expect(halveWindow({ start: "2026-01-01", end: "2026-12-31" }, "total")).toBeNull();
  });
});

describe("monthRange", () => {
  it("lists months inclusive across a year boundary", () => {
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthRange("2026-05", "2026-05")).toEqual(["2026-05"]);
  });

  it("rejects bad input", () => {
    expect(() => monthRange("2026-1", "2026-02")).toThrow(DateError);
    expect(() => monthRange("2026-03", "2026-02")).toThrow(DateError);
  });
});

describe("eventsRangeViolation", () => {
  it("passes a range inside the attribution window", () => {
    expect(eventsRangeViolation({ start: "2026-06-02", end: "2026-08-30" })).toBeNull();
  });

  it("rejects 91 days with no interval, naming the span and the fix", () => {
    const msg = eventsRangeViolation({ start: "2026-06-01", end: "2026-08-30" });
    expect(msg).toMatch(/91 days/);
    expect(msg).toMatch(/interval=month/);
  });

  it("rejects an explicit interval=total over the window", () => {
    expect(eventsRangeViolation({ start: "2026-01-01", end: "2026-12-31", interval: "total" })).toMatch(/365 days/);
  });

  it("allows any span once a sub-interval is set", () => {
    for (const interval of ["month", "week", "day"]) {
      expect(eventsRangeViolation({ start: "2020-01-01", end: "2026-12-31", interval })).toBeNull();
    }
  });

  it("says nothing when the range is incomplete or unparseable", () => {
    expect(eventsRangeViolation({ start: "2026-01-01" })).toBeNull();
    expect(eventsRangeViolation({ end: "2026-01-01" })).toBeNull();
    expect(eventsRangeViolation({})).toBeNull();
    expect(eventsRangeViolation({ start: "last-monday", end: "2026-12-31" })).toBeNull();
  });
});

describe("isEventsPath", () => {
  it("matches the events endpoint for any organization", () => {
    expect(isEventsPath("/api/hoffmann-brothers/events")).toBe(true);
    expect(isEventsPath("/api/acme/events/")).toBe(true);
  });

  it("does not match other endpoints", () => {
    expect(isEventsPath("/api")).toBe(false);
    expect(isEventsPath("/api/acme/benchmarks")).toBe(false);
    expect(isEventsPath("/api/acme/insights")).toBe(false);
  });
});
