import { describe, expect, it } from "vitest";
import { FilterError, encodeFilterValue, filtersToParams } from "../src/filters.js";

describe("encodeFilterValue", () => {
  it("leaves strings raw so simple equality and pre-encoded JSON both work", () => {
    expect(encodeFilterValue("closed")).toBe("closed");
    expect(encodeFilterValue('["or","a","b"]')).toBe('["or","a","b"]');
  });

  it("JSON-encodes expressions, numbers, and booleans", () => {
    expect(encodeFilterValue(["or", "Organic", "Advertising"])).toBe('["or","Organic","Advertising"]');
    expect(encodeFilterValue(["regex", "gmb|gbp", "ui"])).toBe('["regex","gmb|gbp","ui"]');
    expect(encodeFilterValue(true)).toBe("true");
    expect(encodeFilterValue(1000)).toBe("1000");
    expect(encodeFilterValue(null)).toBe("null");
  });
});

describe("filtersToParams", () => {
  it("maps each field to an encoded value and adds the cross-field filter", () => {
    const params = filtersToParams(
      { type: "closed", total: ["gte", 1000], typeIsLast: true },
      ["or", { attributionCategory: "Advertising" }, { total: ["gte", 50000] }],
    );
    expect(params).toEqual({
      type: "closed",
      total: '["gte",1000]',
      typeIsLast: "true",
      filter: '["or",{"attributionCategory":"Advertising"},{"total":["gte",50000]}]',
    });
  });

  it("returns an empty object when nothing is given", () => {
    expect(filtersToParams()).toEqual({});
    expect(filtersToParams({})).toEqual({});
  });

  it("rejects invalid field names and reserved parameters", () => {
    expect(() => filtersToParams({ "bad name": "x" })).toThrow(FilterError);
    expect(() => filtersToParams({ start: "2026-01-01" })).toThrow(/request parameter/);
  });

  it("rejects a cross-field filter that is not an operator expression", () => {
    expect(() => filtersToParams({}, [{ a: 1 }])).toThrow(FilterError);
    expect(() => filtersToParams({}, [])).toThrow(FilterError);
  });

  it("round-trips through URLSearchParams the way curl --data-urlencode does", () => {
    const qs = new URLSearchParams(filtersToParams({ campaign: ["regex", "gmb|gbp", "ui"] })).toString();
    expect(qs).toBe("campaign=%5B%22regex%22%2C%22gmb%7Cgbp%22%2C%22ui%22%5D");
  });
});
