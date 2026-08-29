import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FleetRegistry } from "../src/engine/registry.ts";
import { Router } from "../src/engine/routing/router.ts";
import { FailoverExecutor } from "../src/engine/routing/executor.ts";
import { MoaOrchestrator, isDegenerate, echoesScaffolding, echoesPrompt, isFiller } from "../src/engine/moa/moa.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { Endpoint, MoaConfig } from "../src/engine/types.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

function ep(id: string, modelId: string, sizeB: number, baseUrl: string): Endpoint {
  return { id, host: id, port: 11434, baseUrl, api: "openai-completions", source: "manual",
    models: [{ id: modelId, sizeB, contextWindow: 8192, verified: true }], firstSeen: 0, lastSeen: 0 };
}

describe("MoA orchestrator", () => {
  let w1: FakeOllama, w2: FakeOllama, agg: FakeOllama, broken: FakeOllama;
  before(async () => {
    w1 = new FakeOllama({ models: ["a:8b"], reply: "worker-1-answer" });
    w2 = new FakeOllama({ models: ["b:8b"], reply: "worker-2-answer" });
    agg = new FakeOllama({ models: ["c:120b"], reply: "SYNTHESIZED" });
    broken = new FakeOllama({ models: ["d:70b"], chatStatus: 500 });
    await Promise.all([w1.start(), w2.start(), agg.start(), broken.start()]);
  });
  after(async () => { await Promise.all([w1.stop(), w2.stop(), agg.stop(), broken.stop()]); });

  function setup(extra: Partial<MoaConfig> = {}, withBroken = false) {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const conns: Record<string, { baseUrl: string }> = {};
    const reg = (id: string, model: string, size: number, url: string) => { r.upsert(ep(id, model, size, url)); conns[id] = { baseUrl: url }; };
    reg("w1", "a:8b", 8, w1.baseUrl);
    reg("w2", "b:8b", 8, w2.baseUrl);
    reg("agg", "c:120b", 120, agg.baseUrl);
    if (withBroken) reg("broken", "d:70b", 70, broken.baseUrl);
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const exec = new FailoverExecutor(r, router, (id) => conns[id] ?? null);
    const cfg: MoaConfig = { ...DEFAULT_CONFIG.moa, enabled: true, workers: 2, parallelism: 2, minWorkers: 1, policy: "diverse", ...extra };
    return { r, router, exec, moa: new MoaOrchestrator(cfg, router, exec) };
  }

  test("runs workers in parallel and aggregates", async () => {
    const { moa } = setup({ workers: 2, aggregatorModel: "agg/c:120b" });
    const res = await moa.run({ messages: [{ role: "user", content: "q" }] });
    assert.equal(res.content, "SYNTHESIZED");
    assert.equal(res.usedFallback, false);
    assert.equal(res.succeededWorkers, 2);
    assert.equal(res.aggregatorEndpoint, "agg");
  });

  test("degrades gracefully when a worker fails (partial success still aggregates)", async () => {
    // Force 3 workers incl the broken one; minWorkers 1.
    const { moa } = setup({ workers: 3, parallelism: 3, minWorkers: 1, aggregatorModel: "agg/c:120b" }, true);
    const res = await moa.run({ messages: [{ role: "user", content: "q" }] });
    assert.equal(res.content, "SYNTHESIZED");
    assert.ok(res.succeededWorkers >= 1 && res.succeededWorkers < res.workerCount, "some workers failed but aggregation ran");
  });

  test("falls back to best worker proposal when aggregator fails", async () => {
    const { moa } = setup({ workers: 2, workerModels: ["w1/a:8b", "w2/b:8b"], aggregatorModel: "broken/d:70b" }, true);
    const res = await moa.run({ messages: [{ role: "user", content: "q" }] });
    assert.equal(res.usedFallback, true);
    assert.match(res.content, /worker-\d-answer/);
    assert.equal(res.aggregatorEndpoint, null);
  });

  test("degeneracy guards flag junk vs real answers", () => {
    assert.equal(isDegenerate("-232"), true);
    assert.equal(isDegenerate("   "), true);
    assert.equal(isDegenerate("42"), true);
    assert.equal(isDegenerate("ok"), false);
    assert.equal(isDegenerate("Hi there! What can I help you with?"), false);
    assert.equal(echoesScaffolding("### Candidate 2 (x/y)\nHi\n\nProduce the single best final answer."), true);
    assert.equal(echoesScaffolding("Hello! How can I help?"), false);
  });

  test("echoesPrompt detects honeypot prompt-parroting", () => {
    const prompt = "You are professional OSINTer. collect all available info about ua company firepoint and their partners";
    const parrot = `I'd be happy to help. Regarding "${prompt}", I recommend step by step. ${prompt}`;
    assert.equal(echoesPrompt(parrot, prompt), true);
    assert.equal(echoesPrompt("Firepoint is a company; here is what I found: ...", prompt), false);
    assert.equal(echoesPrompt("anything", "hi"), false); // short prompt -> not flagged
    // Honeypot that quotes only a short prompt-prefix once (real failing case).
    const q = "You are professional OSINTer. collect all available info about firepoint";
    assert.equal(echoesPrompt(`Sure. Regarding "You are professional OSINTer.", I recommend...`, q), true);
    // Canned filler templates (>=2 phrases).
    assert.equal(isFiller(`I'll do my best to assist you with this. I've seen similar requests before and can offer some guidance.`), true);
    assert.equal(isFiller(`Heterogeneous means consisting of parts of different kinds.`), false);
  });

  test("aggregator that echoes the prompt -> falls back to best worker", async () => {
    // Aggregator endpoint replies with the scaffolding (mislabeled public model).
    const echo = new FakeOllama({ models: ["e:120b"], reply: "### Candidate 1 (w/x)\nhi\n\nProduce the single best final answer." });
    await echo.start();
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const conns: Record<string, { baseUrl: string }> = {};
    const reg = (id: string, model: string, size: number, url: string) => { r.upsert(ep(id, model, size, url)); conns[id] = { baseUrl: url }; };
    reg("w1", "a:8b", 8, w1.baseUrl);
    reg("w2", "b:8b", 8, w2.baseUrl);
    reg("echo", "e:120b", 120, echo.baseUrl);
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const exec = new FailoverExecutor(r, router, (id) => conns[id] ?? null);
    const cfg: MoaConfig = { ...DEFAULT_CONFIG.moa, enabled: true, workers: 2, workerModels: ["w1/a:8b", "w2/b:8b"], parallelism: 2, minWorkers: 1, aggregatorModel: "echo/e:120b" };
    const res = await new MoaOrchestrator(cfg, router, exec).run({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.usedFallback, true, "echoed aggregation rejected");
    assert.match(res.content, /worker-\d-answer/, "returned a real worker answer, not the scaffolding");
    await echo.stop();
  });

  test("all-junk workers -> throws so caller reverts to normal routing", async () => {
    const junk1 = new FakeOllama({ models: ["j:8b"], reply: "-232" });
    const junk2 = new FakeOllama({ models: ["k:8b"], reply: "   " });
    await Promise.all([junk1.start(), junk2.start()]);
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const conns: Record<string, { baseUrl: string }> = { j: { baseUrl: junk1.baseUrl }, k: { baseUrl: junk2.baseUrl } };
    r.upsert(ep("j", "j:8b", 8, junk1.baseUrl));
    r.upsert(ep("k", "k:8b", 8, junk2.baseUrl));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const exec = new FailoverExecutor(r, router, (id) => conns[id] ?? null);
    const cfg: MoaConfig = { ...DEFAULT_CONFIG.moa, enabled: true, workers: 2, parallelism: 2, minWorkers: 1 };
    await assert.rejects(() => new MoaOrchestrator(cfg, router, exec).run({ messages: [{ role: "user", content: "hi" }] }), /usable worker answers/);
    await Promise.all([junk1.stop(), junk2.stop()]);
  });

  test("throws when fewer than minWorkers succeed (caller falls back to normal routing)", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    r.upsert(ep("broken", "d:70b", 70, broken.baseUrl));
    const router = new Router(r, DEFAULT_CONFIG.routing);
    const exec = new FailoverExecutor(r, router, () => ({ baseUrl: broken.baseUrl }));
    const cfg: MoaConfig = { ...DEFAULT_CONFIG.moa, enabled: true, workers: 1, parallelism: 1, minWorkers: 1 };
    const moa = new MoaOrchestrator(cfg, router, exec);
    await assert.rejects(() => moa.run({ messages: [{ role: "user", content: "q" }] }), /usable worker answers/);
  });
});
