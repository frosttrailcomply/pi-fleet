import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FleetRegistry } from "../src/engine/registry.ts";
import { Router } from "../src/engine/routing/router.ts";
import { FailoverExecutor } from "../src/engine/routing/executor.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { Endpoint } from "../src/engine/types.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

function ep(id: string, models: Array<{ id: string; sizeB: number; ctx?: number }>, baseUrl = `http://${id}`): Endpoint {
  return {
    id, host: id, port: 11434, baseUrl, api: "openai-completions", source: "manual",
    models: models.map((m) => ({ id: m.id, sizeB: m.sizeB, contextWindow: m.ctx ?? 8192, verified: true })),
    firstSeen: 0, lastSeen: 0,
  };
}

describe("router scoring", () => {
  test("prefers larger model when health/latency equal", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("small", [{ id: "a:8b", sizeB: 8 }]));
    r.upsert(ep("big", [{ id: "b:70b", sizeB: 70 }]));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    assert.equal(router.best()!.endpointId, "big");
  });

  test("latency weight can override capability", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("bigslow", [{ id: "b:70b", sizeB: 70 }]));
    r.upsert(ep("smallfast", [{ id: "a:8b", sizeB: 8 }]));
    // Make big very slow, small fast.
    for (let i = 0; i < 3; i++) { r.recordSuccess("bigslow", 5000, 10); r.recordSuccess("smallfast", 20, 200); }
    const weights = { ...DEFAULT_CONFIG.routing, latency: 5, throughput: 3, capability: 0.5 };
    const router = new Router(r, weights);
    assert.equal(router.best()!.endpointId, "smallfast");
  });

  test("open breaker excluded from ranking", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("a", [{ id: "a:8b", sizeB: 8 }]));
    r.upsert(ep("b", [{ id: "b:8b", sizeB: 8 }]));
    for (let i = 0; i < 3; i++) r.recordFailure("a");
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const ranked = router.rank();
    assert.ok(!ranked.some((c) => c.endpointId === "a"), "unavailable endpoint excluded");
  });

  test("minContext filter drops small-context models", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("a", [{ id: "a:8b", sizeB: 8, ctx: 8192 }]));
    r.upsert(ep("b", [{ id: "b:8b", sizeB: 8, ctx: 131072 }]));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const ranked = router.rank({ minContext: 32768 });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.endpointId, "b");
  });

  test("diverse spreads across endpoints", () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("a", [{ id: "x:8b", sizeB: 8 }, { id: "x:70b", sizeB: 70 }]));
    r.upsert(ep("b", [{ id: "y:8b", sizeB: 8 }]));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const picks = router.diverse(2);
    assert.equal(picks.length, 2);
    assert.notEqual(picks[0]!.endpointId, picks[1]!.endpointId, "different endpoints");
  });
});

describe("failover executor", () => {
  let good: FakeOllama, bad: FakeOllama;
  before(async () => {
    good = new FakeOllama({ models: ["a:8b"], reply: "GOOD", completionTokens: 7 });
    bad = new FakeOllama({ models: ["b:70b"], chatStatus: 500 });
    await Promise.all([good.start(), bad.start()]);
  });
  after(async () => { await Promise.all([good.stop(), bad.stop()]); });

  test("fails over from broken best candidate to working one, records stats", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    // bad is the 70b (higher capability -> ranked first) but returns 500.
    r.upsert(ep("bad", [{ id: "b:70b", sizeB: 70 }], bad.baseUrl));
    r.upsert(ep("good", [{ id: "a:8b", sizeB: 8 }], good.baseUrl));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const conns: Record<string, { baseUrl: string }> = { bad: { baseUrl: bad.baseUrl }, good: { baseUrl: good.baseUrl } };
    const exec = new FailoverExecutor(r, router, (id) => conns[id] ?? null);
    const out = await exec.execute({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.result?.content, "GOOD");
    assert.equal(out.result?.endpointId, "good");
    assert.equal(out.attempts[0]!.endpointId, "bad");
    assert.equal(out.attempts[0]!.ok, false);
    assert.equal(r.get("bad")!.stats.failures, 1);
    assert.equal(r.get("good")!.stats.successes, 1);
    assert.ok(r.get("good")!.stats.throughputTps > 0, "throughput recorded");
  });

  test("returns null result when all candidates fail", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("bad", [{ id: "b:8b", sizeB: 8 }], bad.baseUrl));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const exec = new FailoverExecutor(r, router, () => ({ baseUrl: bad.baseUrl }));
    const out = await exec.execute({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(out.result, null);
    assert.ok(out.attempts.every((a) => !a.ok));
  });
});
