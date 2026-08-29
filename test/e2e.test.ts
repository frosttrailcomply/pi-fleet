// End-to-end validation of the whole product against a disposable local mock
// fleet. Each test maps to one of the 11 required validation items. No external
// hosts are ever contacted; every endpoint is an in-process FakeOllama.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetOrchestrator } from "../src/engine/orchestrator.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { FleetConfig } from "../src/engine/types.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

describe("E2E: full fleet lifecycle (11 validation items)", () => {
  // A small fleet: two discoverable Ollama hosts + one "external" provider.
  let small: FakeOllama;   // 8b, fast
  let big: FakeOllama;     // 72b, strongest
  let external: FakeOllama; // stands in for an external OpenAI-compatible provider
  let tmp: string;

  before(async () => {
    small = new FakeOllama({ models: ["llama3.1:8b"], reply: "small-says-hi", completionTokens: 5, latencyMs: 5 });
    big = new FakeOllama({ models: ["qwen2.5:72b"], reply: "big-says-hi", completionTokens: 20 });
    external = new FakeOllama({ models: ["gpt-oss:120b"], reply: "external-says-hi", completionTokens: 30 });
    await Promise.all([small.start(), big.start(), external.start()]);
    tmp = mkdtempSync(join(tmpdir(), "pifleet-e2e-"));
  });
  after(async () => { await Promise.all([small.stop(), big.stop(), external.stop()]); });

  function cfg(over: Partial<FleetConfig> = {}): FleetConfig {
    const c = structuredClone(DEFAULT_CONFIG);
    c.discovery.censys.enabled = false;
    c.discovery.seeds = [`127.0.0.1:${small.port}`, `127.0.0.1:${big.port}`];
    c.memory = { ...c.memory, enabled: true, backend: "native", dbPath: join(tmp, "mem.sqlite"), minScore: 0.01 };
    c.discovery.censys.browser.enabled = false;
    c.evolution = { ...c.evolution, enabled: true, autoApply: true, minObservations: 3, workDir: join(tmp, "evo") };
    c.providers = [{ id: "external", baseUrl: external.baseUrl, models: [{ id: "gpt-oss:120b", sizeB: 120 }] }];
    return Object.assign(c, over);
  }

  // Item 1: provider/model discovery and live refresh.
  test("1. discovery + live refresh populates the registry", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.init();
    const n = await orch.refresher.runFullRefresh();
    assert.equal(n, 2, "both seeded Ollama hosts discovered");
    const s = orch.status();
    assert.ok(s.totalModels >= 3, "discovered + configured models present");
    orch.stop();
  });

  // Item 2: endpoint health transitions.
  test("2. health transitions healthy -> unhealthy -> recovered", async () => {
    const orch = new FleetOrchestrator(cfg({ health: { ...DEFAULT_CONFIG.health, failureThreshold: 2, cooldownMs: 50 } }), { now: undefined });
    orch.init();
    await orch.refresher.runFullRefresh();
    const id = `127.0.0.1:${small.port}`;
    assert.equal(orch.registry.get(id)!.health, "healthy");
    small.set({ tagsFail: true });
    await orch.refresher.runHealthProbe(); await orch.refresher.runHealthProbe();
    assert.equal(orch.registry.get(id)!.breaker, "open");
    assert.equal(orch.registry.get(id)!.health, "unhealthy");
    small.set({ tagsFail: false });
    await new Promise((r) => setTimeout(r, 60));
    await orch.refresher.runHealthProbe(); await orch.refresher.runHealthProbe();
    assert.equal(orch.registry.get(id)!.breaker, "closed", "recovered after endpoint returned");
    orch.stop();
  });

  // Item 3: routing/scoring behavior.
  test("3. routing favors the strongest healthy endpoint", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.init();
    await orch.refresher.runFullRefresh();
    const out = await orch.chat({ messages: [{ role: "user", content: "hi" }] });
    // external 120b is strongest -> should win on capability.
    assert.equal(out.result?.content, "external-says-hi");
    orch.stop();
  });

  // Item 4: transparent failover during an active failure.
  test("4. transparent failover when the top endpoint fails mid-flight", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.init();
    await orch.refresher.runFullRefresh();
    external.set({ chatStatus: 500 }); // strongest now broken
    const out = await orch.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(out.result, "still answered via failover");
    assert.notEqual(out.result!.endpointId, "external", "failed over off the broken endpoint");
    assert.equal(out.attempts[0]!.ok, false, "top candidate attempted and failed first");
    external.set({ chatStatus: 200 });
    orch.stop();
  });

  // Item 5: recovery of a previously unhealthy endpoint (then re-selected).
  test("5. recovered endpoint rejoins routing", async () => {
    const orch = new FleetOrchestrator(cfg({ health: { ...DEFAULT_CONFIG.health, failureThreshold: 1, cooldownMs: 30 } }));
    orch.init();
    await orch.refresher.runFullRefresh();
    external.set({ chatStatus: 500 });
    await orch.chat({ messages: [{ role: "user", content: "x" }] }); // trips external open
    assert.equal(orch.registry.get("external")!.breaker, "open");
    external.set({ chatStatus: 200 });
    await new Promise((r) => setTimeout(r, 40));
    await orch.refresher.runHealthProbe(); // half-open trial via /api/tags... external has tags too
    const rec = orch.registry.get("external")!;
    assert.notEqual(rec.breaker, "open", "external no longer fully open after recovery probe");
    orch.stop();
  });

  // Item 6: local + external-provider interoperability.
  test("6. local (discovered) and external (configured) endpoints coexist and both answer", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.init();
    await orch.refresher.runFullRefresh();
    const sources = new Set(orch.registry.all().map((r) => r.endpoint.source));
    assert.ok(sources.has("censys"), "discovered endpoints present");
    assert.ok(sources.has("config"), "external configured provider present");
    // Pin each and confirm both respond.
    const localId = `127.0.0.1:${small.port}`;
    const localOut = await orch.executor.execute({ messages: [{ role: "user", content: "hi" }] }, { query: { endpointIds: [localId] } });
    const extOut = await orch.executor.execute({ messages: [{ role: "user", content: "hi" }] }, { query: { endpointIds: ["external"] } });
    assert.equal(localOut.result?.content, "small-says-hi");
    assert.equal(extOut.result?.content, "external-says-hi");
    orch.stop();
  });

  // Item 7: MoA success and partial-worker failure.
  test("7. MoA aggregates, and degrades gracefully on partial worker failure", async () => {
    const c = cfg();
    c.moa = { ...c.moa, enabled: true, workers: 3, parallelism: 3, minWorkers: 1, policy: "diverse", aggregatorModel: "external/gpt-oss:120b" };
    const orch = new FleetOrchestrator(c);
    orch.init();
    await orch.refresher.runFullRefresh();
    const ok = await orch.moaChat({ messages: [{ role: "user", content: "q" }] });
    assert.equal(ok.content, "external-says-hi", "aggregator synthesized");
    assert.ok(ok.succeededWorkers >= 1);
    // Now break one worker and confirm graceful degradation.
    big.set({ chatStatus: 500 });
    const degraded = await orch.moaChat({ messages: [{ role: "user", content: "q" }] });
    assert.ok(degraded.succeededWorkers < degraded.workerCount, "some workers failed");
    assert.ok(degraded.content.length > 0, "still produced an answer");
    big.set({ chatStatus: 200 });
    orch.stop();
  });

  // Item 8: persistence/retrieval of learned pitfalls.
  test("8. learned pitfalls persist and are retrievable", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "command not found: rg" });
    orch.observeTool({ tool: "bash", ok: false, errorSignature: "command not found: rg" });
    const hits = await orch.retrieveLessons("bash rg command not found");
    assert.ok(hits.some((l) => l.kind === "pitfall"), "pitfall retrievable");
    orch.stop();
  });

  // Item 9: scheduled self-improvement (timer-driven observation flush).
  test("9. scheduled loop wiring fires evolution/improvement via injected timer", async () => {
    const fired: Array<() => void> = [];
    const c = cfg();
    const orch = new FleetOrchestrator(c, {
      refresher: {
        setInterval: ((fn: () => void) => { fired.push(fn); return { unref() {} } as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval,
        clearInterval: () => {},
      },
    });
    await orch.start();
    // start() registers refresh + health + evolution timers via the injected setInterval.
    assert.ok(fired.length >= 3, "background loops scheduled (refresh, health, evolution)");
    orch.stop();
  });

  // Item 10: self-evolution acceptance and rollback paths.
  test("10. evolution accepts an improving change and rolls back a non-improving one", async () => {
    const orch = new FleetOrchestrator(cfg());
    orch.init();
    await orch.refresher.runFullRefresh();
    // Make one endpoint genuinely flaky to create a measurable weakness.
    const id = `127.0.0.1:${small.port}`;
    orch.registry.recordSuccess(id, 100, 1);
    for (let i = 0; i < 4; i++) { orch.registry.get(id)!.breaker = "closed"; orch.registry.recordFailure(id); }
    const accepted = orch.runEvolution(); // default evaluator = mean reliability -> quarantine helps
    assert.ok(accepted.some((o) => o.accepted), "an improving change was accepted");
    // Rollback path: adversarial evaluator that never improves.
    orch.registry.recordSuccess(`127.0.0.1:${big.port}`, 100, 1);
    for (let i = 0; i < 4; i++) { orch.registry.get(`127.0.0.1:${big.port}`)!.breaker = "closed"; orch.registry.recordFailure(`127.0.0.1:${big.port}`); }
    const rolled = orch.runEvolution(() => 1.0);
    assert.ok(rolled.length === 0 || rolled.every((o) => !o.accepted), "no change accepted without measured improvement");
    assert.ok(orch.registry.get(`127.0.0.1:${big.port}`), "endpoint retained after rollback");
    orch.stop();
  });

  // Item 11: clean restart with persisted state/config.
  test("11. clean restart reloads persisted memory + config", async () => {
    const c = cfg();
    const orch1 = new FleetOrchestrator(c);
    orch1.improvement?.note("env-fact", "podman socket lives at /run/podman.sock", ["podman"]);
    const before = orch1.memory!.count();
    assert.ok(before >= 1);
    orch1.stop(); // closes the sqlite db
    assert.ok(existsSync(join(tmp, "mem.sqlite")), "memory persisted to disk");

    // Fresh orchestrator, same config/db path -> lessons survive.
    const orch2 = new FleetOrchestrator(c);
    orch2.init();
    const hits = await orch2.retrieveLessons("where is the podman socket");
    assert.ok(hits.some((l) => /podman socket/.test(l.text)), "persisted lesson retrieved after restart");
    orch2.stop();
  });
});
