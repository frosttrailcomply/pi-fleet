import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HindsightBackend } from "../src/engine/memory/hindsight.ts";
import { FleetOrchestrator } from "../src/engine/orchestrator.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { FleetConfig, HindsightConfig } from "../src/engine/types.ts";

/** Minimal in-process Hindsight stand-in: /health, /retain, /recall. */
class MockHindsight {
  private server: Server;
  port = 0;
  retained: Array<{ text: string; kind: string; tags: string[] }> = [];
  healthy = true;
  constructor() {
    this.server = createServer(async (req, res) => {
      const url = req.url ?? "";
      if (url === "/health") { res.writeHead(this.healthy ? 200 : 503).end("ok"); return; }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (url === "/retain") { this.retained.push({ text: body.text, kind: body.kind, tags: body.tags ?? [] }); res.writeHead(200).end("{}"); return; }
      if (url === "/recall") {
        const hits = this.retained
          .filter((r) => r.text.toLowerCase().includes(String(body.query).toLowerCase().split(" ")[0] ?? ""))
          .map((r) => ({ text: r.text, kind: r.kind, tags: r.tags, score: 0.9 }));
        res.writeHead(200).end(JSON.stringify({ results: hits }));
        return;
      }
      res.writeHead(404).end();
    });
  }
  async start() { await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r)); this.port = (this.server.address() as AddressInfo).port; return this.port; }
  async stop() { await new Promise<void>((r) => this.server.close(() => r())); }
  get baseUrl() { return `http://127.0.0.1:${this.port}`; }
}

function hcfg(baseUrl: string): HindsightConfig {
  return { baseUrl, apiKeyEnv: "HINDSIGHT_API_KEY", namespace: "test", timeoutMs: 3000 };
}

describe("HindsightBackend", () => {
  let mock: MockHindsight;
  before(async () => { mock = new MockHindsight(); await mock.start(); });
  after(async () => { await mock.stop(); });

  test("probe reflects health; retain + recall round-trip", async () => {
    const h = new HindsightBackend(hcfg(mock.baseUrl));
    assert.equal(await h.probe(), true);
    await h.retain({ kind: "pitfall", text: "npm proxy hang without HTTPS_PROXY", tags: ["npm"], context: "npm" });
    const hits = await h.retrieve("npm proxy", [], 5, 0.1);
    assert.ok(hits.some((l) => /npm proxy/.test(l.text)));
    assert.equal(hits[0]!.kind, "pitfall");
  });

  test("unreachable service: probe false, calls no-op", async () => {
    const h = new HindsightBackend(hcfg("http://127.0.0.1:1"));
    assert.equal(await h.probe(), false);
    assert.deepEqual(await h.retrieve("x", [], 5, 0.1), []);
  });
});

describe("orchestrator with Hindsight as default backend", () => {
  let mock: MockHindsight;
  before(async () => { mock = new MockHindsight(); await mock.start(); });
  after(async () => { await mock.stop(); });

  function cfg(baseUrl: string): FleetConfig {
    const c = structuredClone(DEFAULT_CONFIG);
    c.discovery.enabled = false;
    c.discovery.censys.browser.enabled = false;
    c.memory = { ...c.memory, enabled: true, backend: "hindsight", dbPath: ":memory:", minScore: 0.01, hindsight: hcfg(baseUrl) };
    return c;
  }

  test("start() probes Hindsight; observe retains there; retrieve reads from it", async () => {
    const orch = new FleetOrchestrator(cfg(mock.baseUrl), { memoryDbPath: ":memory:" });
    await orch.start();
    await orch.initMemoryBackend(); // start() probes in the background; await it here
    assert.equal(orch.activeMemoryBackend(), "hindsight");
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "rg not found" });
    await new Promise((r) => setTimeout(r, 30)); // let fire-and-forget retain land
    const hits = await orch.retrieveLessons("rg not found");
    assert.ok(hits.length >= 1, "recalled from Hindsight");
    assert.equal(orch.status().memoryBackend, "hindsight");
    orch.stop();
  });

  test("falls back to native when Hindsight is unreachable", async () => {
    const orch = new FleetOrchestrator(cfg("http://127.0.0.1:1"), { memoryDbPath: ":memory:" });
    await orch.start();
    assert.equal(orch.activeMemoryBackend(), "native", "graceful fallback");
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "rg not found" });
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "rg not found" });
    const hits = await orch.retrieveLessons("bash rg not found");
    assert.ok(hits.some((l) => l.kind === "pitfall"), "native memory still works");
    orch.stop();
  });
});
