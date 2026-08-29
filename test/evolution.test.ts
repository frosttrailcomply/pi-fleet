import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetRegistry } from "../src/engine/registry.ts";
import { Router } from "../src/engine/routing/router.ts";
import { MemoryStore } from "../src/engine/memory/store.ts";
import { EvolutionEngine } from "../src/engine/memory/evolve.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { Endpoint, FleetConfig } from "../src/engine/types.ts";

function ep(id: string, sizeB = 8): Endpoint {
  return { id, host: id, port: 11434, baseUrl: `http://${id}`, api: "ollama", source: "manual",
    models: [{ id: `${id}:model`, sizeB, contextWindow: 8192, verified: true }], firstSeen: 0, lastSeen: 0 };
}

function freshFleetConfig(workDir: string): FleetConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.evolution = { ...c.evolution, enabled: true, autoApply: true, minObservations: 4, workDir };
  return c;
}

describe("evolution: analyze", () => {
  test("flags flaky endpoint past minObservations", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("flaky"));
    // 1 success, 4 failures -> rate 0.2 over 5 (>= minObservations 4).
    r.recordSuccess("flaky", 100, 1);
    for (let i = 0; i < 4; i++) { r.get("flaky")!.breaker = "closed"; r.recordFailure("flaky"); }
    const wd = mkdtempSync(join(tmpdir(), "evo-"));
    const cfg = freshFleetConfig(wd);
    const evo = new EvolutionEngine(cfg.evolution, cfg, r, new Router(r, cfg.routing), new MemoryStore(":memory:"));
    const w = evo.analyze();
    assert.ok(w.some((x) => x.kind === "flaky-endpoint" && x.target === "flaky"));
  });
});

describe("evolution: accept path", () => {
  test("quarantines flaky endpoint when evaluator improves, records lesson + artifact", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("flaky"));
    r.upsert(ep("solid", 70));
    // Make flaky genuinely bad.
    r.recordSuccess("flaky", 100, 1);
    for (let i = 0; i < 5; i++) { r.get("flaky")!.breaker = "closed"; r.recordFailure("flaky"); }
    for (let i = 0; i < 5; i++) r.recordSuccess("solid", 50, 20);

    const wd = mkdtempSync(join(tmpdir(), "evo-"));
    const cfg = freshFleetConfig(wd);
    const mem = new MemoryStore(":memory:");
    const evo = new EvolutionEngine(cfg.evolution, cfg, r, new Router(r, cfg.routing), mem);

    // Evaluator: mean reliability of remaining endpoints (removing flaky raises it).
    const evaluate = () => {
      const recs = r.all();
      if (recs.length === 0) return 0;
      return recs.reduce((a, rec) => a + r.reliability(rec.endpoint.id), 0) / recs.length;
    };

    const outcomes = evo.runCycle(evaluate);
    const accepted = outcomes.find((o) => o.proposal.weakness.kind === "flaky-endpoint");
    assert.ok(accepted?.accepted, "flaky quarantine accepted");
    assert.equal(r.get("flaky"), undefined, "flaky endpoint removed");
    assert.ok(mem.all().some((l) => l.tags.includes("accepted")), "acceptance lesson recorded");
    assert.ok(readdirSync(wd).length > 0, "artifact persisted");
  });
});

describe("evolution: rollback path", () => {
  test("rolls back a change the evaluator does not favor, leaving state intact", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("a"));
    r.recordSuccess("a", 100, 1);
    for (let i = 0; i < 5; i++) { r.get("a")!.breaker = "closed"; r.recordFailure("a"); }

    const wd = mkdtempSync(join(tmpdir(), "evo-"));
    const cfg = freshFleetConfig(wd);
    const mem = new MemoryStore(":memory:");
    const evo = new EvolutionEngine(cfg.evolution, cfg, r, new Router(r, cfg.routing), mem);

    // Adversarial evaluator: always reports the SAME score -> no improvement ever.
    const evaluate = () => 1.0;
    const outcomes = evo.runCycle(evaluate);
    assert.ok(outcomes.length > 0);
    assert.ok(outcomes.every((o) => !o.accepted), "nothing accepted without measured improvement");
    assert.ok(r.get("a"), "endpoint NOT removed (change rolled back)");
    assert.ok(mem.all().some((l) => l.tags.includes("rejected")), "rejection lesson recorded");
  });
});

describe("evolution: code proposals are artifact-only", () => {
  test("recurring pitfall emits a non-auto-applied artifact", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const wd = mkdtempSync(join(tmpdir(), "evo-"));
    const cfg = freshFleetConfig(wd);
    const mem = new MemoryStore(":memory:");
    // Strong recurring pitfall (weight above threshold 2 + 4*0.5 = 4).
    for (let i = 0; i < 8; i++) mem.remember({ kind: "pitfall", text: "bash rg missing", tags: ["bash"], context: "bash|rg", weight: 1 });
    const evo = new EvolutionEngine(cfg.evolution, cfg, r, new Router(r, cfg.routing), mem);
    const outcomes = evo.runCycle(() => 1.0);
    const pit = outcomes.find((o) => o.proposal.weakness.kind === "recurring-pitfall");
    assert.ok(pit, "pitfall proposal produced");
    assert.equal(pit!.proposal.autoApplicable, false, "code proposal never auto-applied");
    assert.equal(pit!.accepted, false);
  });
});

describe("evolution: git-tracked commit on accept", () => {
  test("invokes injected git runner on acceptance", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("flaky"));
    r.upsert(ep("solid", 70));
    r.recordSuccess("flaky", 100, 1);
    for (let i = 0; i < 5; i++) { r.get("flaky")!.breaker = "closed"; r.recordFailure("flaky"); }
    for (let i = 0; i < 5; i++) r.recordSuccess("solid", 50, 20);
    const wd = mkdtempSync(join(tmpdir(), "evo-"));
    const cfg = freshFleetConfig(wd);
    const calls: string[][] = [];
    const evo = new EvolutionEngine(cfg.evolution, cfg, r, new Router(r, cfg.routing), new MemoryStore(":memory:"), (args) => calls.push(args));
    const evaluate = () => {
      const recs = r.all();
      return recs.length ? recs.reduce((a, rec) => a + r.reliability(rec.endpoint.id), 0) / recs.length : 0;
    };
    evo.runCycle(evaluate);
    assert.ok(calls.some((c) => c[0] === "add"), "git add invoked on accept");
    assert.ok(calls.some((c) => c[0] === "commit"), "git commit invoked on accept");
  });
});
