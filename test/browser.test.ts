import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { expandEnv, readPath, scrapeCensysViaBrowser, type CommandRunner } from "../src/engine/discovery/browser.ts";
import { FleetRegistry } from "../src/engine/registry.ts";
import { FleetRefresher } from "../src/engine/discovery/refresher.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { BrowserScrapeConfig } from "../src/engine/types.ts";

const SAMPLE_HTML = `
  <a title="View 1.2.3.4:8080 Details"></a>
  <a href="https://platform.censys.io/hosts/9.9.9.9?at_time=z"></a>
  <a title="View 5.6.7.8:11434 Details"></a>
`;

function cfg(over: Partial<BrowserScrapeConfig> = {}): BrowserScrapeConfig {
  return { enabled: true, command: ["fake", "{url}"], searchUrl: "https://platform.censys.io/search?q={query}", resultPath: "", timeoutMs: 5000, ...over };
}

describe("browser scrape helpers", () => {
  test("expandEnv resolves ${VAR} and $VAR, blanks unknown", () => {
    process.env.BS_TEST_DIR = "/opt/bs";
    assert.equal(expandEnv("${BS_TEST_DIR}/x"), "/opt/bs/x");
    assert.equal(expandEnv("$BS_TEST_DIR/y"), "/opt/bs/y");
    assert.equal(expandEnv("${BS_UNSET_XYZ}/z"), "/z");
  });
  test("readPath walks dot paths incl array indices", () => {
    const obj = { results: [{ content: "hi" }, { content: "no" }] };
    assert.equal(readPath(obj, "results.0.content"), "hi");
    assert.equal(readPath(obj, ""), obj);
    assert.equal(readPath(obj, "results.9.content"), undefined);
  });
});

describe("scrapeCensysViaBrowser", () => {
  test("raw-HTML stdout is parsed for host:port", async () => {
    const run: CommandRunner = async (_cmd, args) => {
      assert.ok(args[0]!.includes("censys.io/search?q="), "url substituted + encoded");
      return { code: 0, stdout: SAMPLE_HTML, stderr: "" };
    };
    const hosts = await scrapeCensysViaBrowser(cfg(), "ollama", { run });
    const set = new Set(hosts.map((h) => `${h.host}:${h.port}`));
    assert.ok(set.has("1.2.3.4:8080") && set.has("9.9.9.9:11434") && set.has("5.6.7.8:11434"));
  });

  test("JSON stdout with resultPath (smart-extract shape) is unwrapped", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ mode: "camofox", results: [{ ok: true, content: SAMPLE_HTML }] }), stderr: "" });
    const hosts = await scrapeCensysViaBrowser(cfg({ resultPath: "results.0.content" }), "ollama", { run });
    assert.ok(hosts.some((h) => h.host === "1.2.3.4" && h.port === 8080));
  });

  test("disabled or empty command returns []", async () => {
    assert.deepEqual(await scrapeCensysViaBrowser(cfg({ enabled: false }), "q", { run: async () => ({ code: 0, stdout: SAMPLE_HTML, stderr: "" }) }), []);
    assert.deepEqual(await scrapeCensysViaBrowser(cfg({ command: [] }), "q"), []);
  });

  test("command failure with no output returns [] (caller falls back)", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "boom" });
    assert.deepEqual(await scrapeCensysViaBrowser(cfg(), "q", { run }), []);
  });
});

describe("refresher uses browser scrape as a candidate source", () => {
  test("gatherCandidates includes browser-scraped hosts", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const disc = structuredClone(DEFAULT_CONFIG.discovery);
    disc.seeds = [];
    disc.censys = { ...disc.censys, enabled: true, htmlImports: [], browser: cfg({ resultPath: "results.0.content" }) };
    const run: CommandRunner = async () => ({ code: 0, stdout: JSON.stringify({ results: [{ content: SAMPLE_HTML }] }), stderr: "" });
    const ref = new FleetRefresher(r, disc, DEFAULT_CONFIG.health, { commandRunner: run });
    const cands = await ref.gatherCandidates();
    const set = new Set(cands.map((c) => `${c.host}:${c.port}`));
    assert.ok(set.has("1.2.3.4:8080") && set.has("5.6.7.8:11434"));
  });
});
