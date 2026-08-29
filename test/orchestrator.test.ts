import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FleetOrchestrator } from "../src/engine/orchestrator.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { FleetConfig } from "../src/engine/types.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

function cfgWith(over: Partial<FleetConfig>): FleetConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...over };
}

describe("orchestrator integration", () => {
  let a: FakeOllama, b: FakeOllama;
  before(async () => {
    a = new FakeOllama({ models: ["llama3.1:8b"], reply: "from-a" });
    b = new FakeOllama({ models: ["qwen2.5:72b"], reply: "from-b" });
    await Promise.all([a.start(), b.start()]);
  });
  after(async () => { await Promise.all([a.stop(), b.stop()]); });

  test("init registers configured providers; chat routes to strongest", async () => {
    const cfg = cfgWith({
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      providers: [
        { id: "a", baseUrl: a.baseUrl, models: [{ id: "llama3.1:8b", sizeB: 8 }] },
        { id: "b", baseUrl: b.baseUrl, models: [{ id: "qwen2.5:72b", sizeB: 72 }] },
      ],
    });
    const orch = new FleetOrchestrator(cfg);
    orch.init();
    const out = await orch.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.result?.content, "from-b", "routed to the 72b endpoint");
    orch.stop();
  });

  test("listModels exposes virtual auto + discovered models", () => {
    const cfg = cfgWith({
      moa: { ...DEFAULT_CONFIG.moa, enabled: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false },
      providers: [{ id: "a", baseUrl: a.baseUrl, models: [{ id: "llama3.1:8b", sizeB: 8 }] }],
    });
    const orch = new FleetOrchestrator(cfg);
    orch.init();
    const ids = orch.listModels().map((m) => m.id);
    assert.ok(ids.includes("auto") && ids.includes("moa"));
    assert.ok(ids.includes("a/llama3.1:8b"));
    orch.stop();
  });

  test("observeTool + retrieveLessons round-trips through memory", async () => {
    const cfg = cfgWith({ memory: { ...DEFAULT_CONFIG.memory, enabled: true, dbPath: ":memory:", minScore: 0.01 } });
    const orch = new FleetOrchestrator(cfg, { memoryDbPath: ":memory:" });
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "rg not found" });
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "rg not found" });
    const hits = await orch.retrieveLessons("bash rg not found");
    assert.ok(hits.length >= 1);
    assert.equal(orch.activeMemoryBackend(), "native", "native backend when Hindsight not probed");
    orch.stop();
  });

  test("status reflects endpoints and memory", () => {
    const cfg = cfgWith({
      memory: { ...DEFAULT_CONFIG.memory, enabled: true, dbPath: ":memory:" },
      providers: [{ id: "a", baseUrl: a.baseUrl, models: [{ id: "m", sizeB: 8 }] }],
    });
    const orch = new FleetOrchestrator(cfg, { memoryDbPath: ":memory:" });
    orch.init();
    const s = orch.status();
    assert.equal(s.endpoints.length, 1);
    assert.equal(s.endpoints[0]!.source, "config");
    orch.stop();
  });
});
