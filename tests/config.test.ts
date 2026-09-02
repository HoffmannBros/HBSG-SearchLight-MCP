import { describe, expect, it } from "vitest";
import path from "node:path";
import { DEFAULT_BASE_URL, expandPathTokens, loadConfig } from "../src/config.js";

const home = path.resolve("/Users/example");

describe("expandPathTokens", () => {
  it("expands the MCPB placeholders that Claude Desktop leaves literal", () => {
    expect(expandPathTokens("${DOCUMENTS}/SearchLight Reports", home)).toBe(
      path.join(home, "Documents", "SearchLight Reports"),
    );
    expect(expandPathTokens("${HOME}/x", home)).toBe(path.join(home, "x"));
    expect(expandPathTokens("${DESKTOP}", home)).toBe(path.join(home, "Desktop"));
    expect(expandPathTokens("${DOWNLOADS}", home)).toBe(path.join(home, "Downloads"));
  });

  it("expands a leading tilde and trims whitespace", () => {
    expect(expandPathTokens("  ~/reports ", home)).toBe(path.join(home, "reports"));
  });

  it("leaves absolute paths alone", () => {
    const abs = path.resolve("/data/out");
    expect(expandPathTokens(abs, home)).toBe(abs);
  });
});

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    const cfg = loadConfig({}, home);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.outputDir).toBe(path.join(home, "Documents", "SearchLight Reports"));
    expect(cfg.defaultOrganization).toBeUndefined();
    expect(cfg.concurrency).toBe(4);
    expect(cfg.timeoutMs).toBe(120_000);
  });

  it("treats blank strings as unset and strips trailing slashes from the base URL", () => {
    const cfg = loadConfig(
      {
        SEARCHLIGHT_API_KEY: "  ",
        SEARCHLIGHT_DEFAULT_ORGANIZATION: "",
        SEARCHLIGHT_BASE_URL: "https://example.test///",
        SEARCHLIGHT_CONCURRENCY: "zero",
      },
      home,
    );
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.defaultOrganization).toBeUndefined();
    expect(cfg.baseUrl).toBe("https://example.test");
    expect(cfg.concurrency).toBe(4);
  });

  it("reads explicit values", () => {
    const cfg = loadConfig(
      {
        SEARCHLIGHT_API_KEY: "sl_abc",
        SEARCHLIGHT_DEFAULT_ORGANIZATION: "hoffmann",
        SEARCHLIGHT_OUTPUT_DIR: "${HOME}/out",
        SEARCHLIGHT_CONCURRENCY: "2",
      },
      home,
    );
    expect(cfg.apiKey).toBe("sl_abc");
    expect(cfg.defaultOrganization).toBe("hoffmann");
    expect(cfg.outputDir).toBe(path.join(home, "out"));
    expect(cfg.concurrency).toBe(2);
  });
});
