import { describe, expect, it } from "vitest";
import type { AccessInfo } from "../src/client.js";
import { SearchLightConfigError } from "../src/client.js";
import { checkScope, rawPathProblem } from "../src/scope.js";

const access: AccessInfo = {
  user: "me@example.com",
  organizations: [
    { organization: "hb", accounts: ["hb-stl", "hb-nash"] },
    { organization: "solo", accounts: [] },
  ],
  endpoints: [],
  dictionary: {},
};

describe("checkScope", () => {
  it("passes an organization and its own accounts through", () => {
    expect(checkScope(access, "hb", ["hb-stl"])).toEqual({ organization: "hb", accounts: ["hb-stl"], notes: [] });
    expect(checkScope(access, "hb", undefined)).toEqual({ organization: "hb", accounts: undefined, notes: [] });
  });

  it("refuses accounts outside the organization and names them", () => {
    expect(() => checkScope(access, "hb", ["hb-stl", "other"])).toThrow(SearchLightConfigError);
    expect(() => checkScope(access, "hb", ["other"])).toThrow(/"other" is not under organization "hb".*hb-stl, hb-nash/);
  });

  it("reroutes an account key given as the organization through its parent", () => {
    const scope = checkScope(access, "hb-nash", undefined);
    expect(scope.organization).toBe("hb");
    expect(scope.accounts).toEqual(["hb-nash"]);
    expect(scope.notes[0]).toMatch(/2026-09-21/);
    expect(checkScope(access, "hb-nash", ["hb-nash"]).accounts).toEqual(["hb-nash"]);
  });

  it("refuses an account key as organization combined with different accounts", () => {
    expect(() => checkScope(access, "hb-nash", ["hb-stl"])).toThrow(/account under "hb"/);
  });

  it("refuses an unknown organization and lists the options", () => {
    expect(() => checkScope(access, "nope", undefined)).toThrow(/Organizations: hb, solo/);
  });

  it("does not check accounts for an organization that lists none", () => {
    expect(checkScope(access, "solo", ["solo"]).organization).toBe("solo");
  });
});

describe("rawPathProblem", () => {
  it("flags an account key in the path with the corrected route", () => {
    expect(rawPathProblem(access, "/api/hb-stl/events", {})).toMatch(/\/api\/hb\/\.\.\. with account=hb-stl/);
  });

  it("flags accounts outside the organization in either parameter", () => {
    expect(rawPathProblem(access, "/api/hb/events", { account: "zzz" })).toMatch(/"zzz"/);
    expect(rawPathProblem(access, "/api/hb/events", { accounts: "hb-stl,zzz" })).toMatch(/"zzz"/);
  });

  it("accepts good requests and paths without an organization", () => {
    expect(rawPathProblem(access, "/api/hb/events", { accounts: "hb-stl,hb-nash" })).toBeUndefined();
    expect(rawPathProblem(access, "/api", {})).toBeUndefined();
  });
});
