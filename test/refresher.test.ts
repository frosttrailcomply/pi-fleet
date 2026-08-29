import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FleetRegistry } from "../src/engine/registry.ts";
import { FleetRefresher } from "../src/engine/discovery/refresher.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

describe("refresher", () => {
  let live: FakeOllama;
  before(async () => { live = new FakeOllama({ models: ["llama3.1:8b"] }); await live.start(); });
  after(async () => { await live.stop(); });

  test("full refresh from seeds populates registry with verified models", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const disc = { ...DEFAULT_CONFIG.discovery, seeds: [`127.0.0.1:${live.port}`], censys: { ...DEFAULT_CONFIG.discovery.censys, enabled: false } };
    const ref = new FleetRefresher(r, disc, DEFAULT_CONFIG.health);
    const n = await ref.runFullRefresh();
    assert.equal(n, 1);
    const rec = r.get(`127.0.0.1:${live.port}`)!;
    assert.ok(rec, "endpoint registered");
    assert.equal(rec.endpoint.models[0]!.id, "llama3.1:8b");
  });

  test("health probe recovers a returned endpoint via breaker", async () => {
    const flaky = new FakeOllama({ models: ["x:8b"] });
    await flaky.start();
    let clock = 0;
    const r = new FleetRegistry({ ...DEFAULT_CONFIG.health, failureThreshold: 2, cooldownMs: 100 }, () => clock);
    const disc = { ...DEFAULT_CONFIG.discovery, seeds: [`127.0.0.1:${flaky.port}`], censys: { ...DEFAULT_CONFIG.discovery.censys, enabled: false } };
    const ref = new FleetRefresher(r, disc, { ...DEFAULT_CONFIG.health, failureThreshold: 2, cooldownMs: 100 });
    await ref.runFullRefresh();
    const id = `127.0.0.1:${flaky.port}`;

    // Simulate outage: tags start failing.
    flaky.set({ tagsFail: true });
    await ref.runHealthProbe(); await ref.runHealthProbe();
    assert.equal(r.get(id)!.breaker, "open", "breaker opens on repeated probe failure");

    // Endpoint comes back; advance clock past cooldown then probe.
    flaky.set({ tagsFail: false });
    clock += 100;
    await ref.runHealthProbe(); // half-open trial success
    await ref.runHealthProbe(); // second success closes (recoveryThreshold default 2)
    assert.equal(r.get(id)!.breaker, "closed", "breaker recovers after endpoint returns");
    await flaky.stop();
  });

  test("gatherCandidates ingests saved Censys HTML import path", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const html = `${process.cwd()}/test/fixtures/censys-sample.html`;
    const disc = {
      ...DEFAULT_CONFIG.discovery, seeds: [],
      censys: { ...DEFAULT_CONFIG.discovery.censys, enabled: true, htmlImports: [html] },
    };
    const ref = new FleetRefresher(r, disc, DEFAULT_CONFIG.health);
    const cands = await ref.gatherCandidates();
    const set = new Set(cands.map((c) => `${c.host}:${c.port}`));
    assert.ok(set.has("1.2.3.4:8080"));
    assert.ok(set.has("9.9.9.9:11434"));
  });

  test("start/stop uses injected timers and is idempotent", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const timers: Array<() => void> = [];
    const disc = { ...DEFAULT_CONFIG.discovery, seeds: [`127.0.0.1:${live.port}`], censys: { ...DEFAULT_CONFIG.discovery.censys, enabled: false } };
    const fakeInterval = ((fn: () => void) => { timers.push(fn); return { unref() {} } as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval;
    const ref = new FleetRefresher(r, disc, DEFAULT_CONFIG.health, { setInterval: fakeInterval, clearInterval: () => {} });
    await ref.start();
    await ref.start(); // idempotent
    assert.equal(timers.length, 2, "exactly refresh + health timers registered once");
    ref.stop();
  });
});
