import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FleetRegistry } from "../src/engine/registry.ts";
import type { Endpoint, HealthConfig } from "../src/engine/types.ts";

const CFG: HealthConfig = { failureThreshold: 3, cooldownMs: 1000, recoveryThreshold: 2, requestTimeoutMs: 5000, ewmaAlpha: 0.5 };

function ep(id: string): Endpoint {
  return { id, host: "127.0.0.1", port: 11434, baseUrl: `http://${id}`, api: "ollama", source: "manual", models: [{ id: "m", sizeB: 8, contextWindow: 8192, verified: true }], firstSeen: 0, lastSeen: 0 };
}

describe("registry: upsert + merge", () => {
  test("upsert inserts then merges models preserving stats", () => {
    const r = new FleetRegistry(CFG);
    r.upsert(ep("a"));
    r.recordSuccess("a", 100, 10);
    const e2 = ep("a");
    e2.models = [{ id: "m2", sizeB: 70, contextWindow: 131072, verified: true }];
    r.upsert(e2);
    const rec = r.get("a")!;
    assert.equal(rec.stats.successes, 1, "stats preserved across upsert");
    assert.deepEqual(rec.endpoint.models.map((m) => m.id).sort(), ["m", "m2"], "models merged");
  });
});

describe("registry: circuit breaker", () => {
  test("trips open after threshold consecutive failures", () => {
    const r = new FleetRegistry(CFG);
    r.upsert(ep("a"));
    r.recordFailure("a"); r.recordFailure("a");
    assert.equal(r.get("a")!.breaker, "closed");
    assert.equal(r.isAvailable("a"), true);
    r.recordFailure("a"); // 3rd -> open
    assert.equal(r.get("a")!.breaker, "open");
    assert.equal(r.get("a")!.health, "unhealthy");
    assert.equal(r.isAvailable("a"), false, "open breaker blocks calls");
  });

  test("cooldown -> half-open -> recovery closes", () => {
    let clock = 0;
    const r = new FleetRegistry(CFG, () => clock);
    r.upsert(ep("a"));
    r.recordFailure("a"); r.recordFailure("a"); r.recordFailure("a");
    assert.equal(r.isAvailable("a"), false);
    clock += 1000; // cooldown elapsed
    assert.equal(r.isAvailable("a"), true, "moves to half-open after cooldown");
    assert.equal(r.get("a")!.breaker, "half-open");
    assert.equal(r.get("a")!.health, "degraded");
    r.recordSuccess("a", 50, 5); // 1st half-open success
    assert.equal(r.get("a")!.breaker, "half-open");
    r.recordSuccess("a", 50, 5); // 2nd -> closed
    assert.equal(r.get("a")!.breaker, "closed");
    assert.equal(r.get("a")!.health, "healthy");
  });

  test("failure during half-open re-opens immediately", () => {
    let clock = 0;
    const r = new FleetRegistry(CFG, () => clock);
    r.upsert(ep("a"));
    r.recordFailure("a"); r.recordFailure("a"); r.recordFailure("a");
    clock += 1000;
    r.isAvailable("a"); // -> half-open
    r.recordFailure("a");
    assert.equal(r.get("a")!.breaker, "open");
    assert.equal(r.isAvailable("a"), false);
  });
});

describe("registry: rolling stats", () => {
  test("EWMA latency + throughput seed then smooth", () => {
    const r = new FleetRegistry(CFG);
    r.upsert(ep("a"));
    r.recordSuccess("a", 100, 100); // seeds latency=100, tps=1000
    assert.equal(r.get("a")!.stats.latencyMs, 100);
    assert.equal(r.get("a")!.stats.throughputTps, 1000);
    r.recordSuccess("a", 200, 100); // alpha 0.5 -> latency 150
    assert.equal(r.get("a")!.stats.latencyMs, 150);
  });

  test("reliability drops with consecutive failures", () => {
    const r = new FleetRegistry(CFG);
    r.upsert(ep("a"));
    for (let i = 0; i < 5; i++) r.recordSuccess("a", 10, 1);
    const high = r.reliability("a");
    r.recordFailure("a");
    assert.ok(r.reliability("a") < high, "reliability penalized after a failure");
  });
});
