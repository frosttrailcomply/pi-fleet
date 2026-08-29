import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { FleetOrchestrator } from "../src/engine/orchestrator.ts";
import { FleetGateway } from "../src/ext/gateway.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { FleetConfig } from "../src/engine/types.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

describe("fleet gateway (OpenAI-compatible surface)", () => {
  let big: FakeOllama, small: FakeOllama;
  let orch: FleetOrchestrator, gw: FleetGateway;

  before(async () => {
    big = new FakeOllama({ models: ["qwen2.5:72b"], reply: "big-hi", completionTokens: 10 });
    small = new FakeOllama({ models: ["llama3.1:8b"], reply: "small-hi" });
    await Promise.all([big.start(), small.start()]);
    const cfg: FleetConfig = structuredClone(DEFAULT_CONFIG);
    cfg.memory.enabled = false;
    cfg.providers = [
      { id: "big", baseUrl: big.baseUrl, models: [{ id: "qwen2.5:72b", sizeB: 72 }] },
      { id: "small", baseUrl: small.baseUrl, models: [{ id: "llama3.1:8b", sizeB: 8 }] },
    ];
    orch = new FleetOrchestrator(cfg);
    orch.init();
    gw = new FleetGateway(orch);
    await gw.start(0);
  });
  after(async () => { await gw.stop(); await Promise.all([big.stop(), small.stop()]); });

  test("GET /v1/models lists fleet models", async () => {
    const res = await fetch(`${gw.baseUrl}/models`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("auto"));
    assert.ok(ids.includes("big/qwen2.5:72b"));
  });

  test("POST /v1/chat/completions model=auto routes to strongest", async () => {
    const res = await fetch(`${gw.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, "big-hi");
  });

  test("pinned model routes to that endpoint", async () => {
    const res = await fetch(`${gw.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "small/llama3.1:8b", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, "small-hi");
  });

  test("stream:true returns SSE ending in [DONE]", async () => {
    const res = await fetch(`${gw.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.match(res.headers.get("content-type") ?? "", /event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"big-hi"/);
    assert.match(text, /\[DONE\]/);
  });

  test("failover: break strongest, gateway still answers", async () => {
    big.set({ chatStatus: 500 });
    const res = await fetch(`${gw.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(body.choices[0]!.message.content, "small-hi", "failed over to small");
    big.set({ chatStatus: 200 });
  });
});
