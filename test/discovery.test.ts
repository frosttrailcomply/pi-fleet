import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { extractFromHtml, queryCensys } from "../src/engine/discovery/censys.ts";
import { parseSizeB, guessContext, fetchTags, verifyModel, reconFleet } from "../src/engine/discovery/probe.ts";
import { FakeOllama } from "../src/mock/fake-ollama.ts";

describe("censys HTML extraction (port of extract_ollama_hosts.py)", () => {
  test("pulls host:port from View titles and detail URLs, dedupes, defaults port", () => {
    const html = `
      <a title="View 51.20.254.126:4841 Details"></a>
      <a href="https://platform.censys.io/hosts/8.8.8.8?at_time=x"></a>
      <a href="https://platform.censys.io/web/1.2.3.4:8080?at_time=y"></a>
      <a title="View 8.8.8.8 Details"></a>
      <a title="View 999.1.1.1 Details"></a>
    `;
    const hp = extractFromHtml(html);
    const set = new Set(hp.map((h) => `${h.host}:${h.port}`));
    assert.ok(set.has("51.20.254.126:4841"));
    assert.ok(set.has("8.8.8.8:11434"), "bare host defaults to 11434");
    assert.ok(set.has("1.2.3.4:8080"));
    assert.equal([...set].filter((s) => s.startsWith("8.8.8.8")).length, 1, "deduped");
    assert.ok(![...set].some((s) => s.startsWith("999.")), "invalid IP rejected");
  });

  test("censys API path returns [] on non-ok without throwing", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const out = await queryCensys("q", { id: "x", secret: "y" }, { fetchImpl: fakeFetch });
    assert.deepEqual(out, []);
  });

  test("censys API path parses hits + services into host:port", async () => {
    const payload = { result: { hits: [{ ip: "10.0.0.1", services: [{ port: 11434 }, { port: 8080 }] }, { ip: "10.0.0.2" }] } };
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const out = await queryCensys("q", { id: "x", secret: "y" }, { fetchImpl: fakeFetch });
    const set = new Set(out.map((h) => `${h.host}:${h.port}`));
    assert.ok(set.has("10.0.0.1:11434") && set.has("10.0.0.1:8080") && set.has("10.0.0.2:11434"));
  });
});

describe("model name parsing", () => {
  test("parseSizeB", () => {
    assert.equal(parseSizeB("llama3.1:70b"), 70);
    assert.equal(parseSizeB("gemma2:2b"), 2);
    assert.equal(parseSizeB("qwen2.5:1.5b-instruct"), 1.5);
    assert.equal(parseSizeB("mixtral:8x7b"), 56);
    assert.equal(parseSizeB("nomic-embed-text"), 0);
  });
  test("guessContext", () => {
    assert.equal(guessContext("llama3.1:8b"), 131072);
    assert.equal(guessContext("gemma2:2b"), 8192);
    assert.equal(guessContext("unknown-model"), 8192);
  });
});

describe("probe against fake ollama", () => {
  let live: FakeOllama, dead: FakeOllama, broken: FakeOllama;
  before(async () => {
    live = new FakeOllama({ models: ["llama3.1:8b", "qwen2.5:7b"], reply: "hi" });
    dead = new FakeOllama({ tagsFail: true });
    broken = new FakeOllama({ models: ["ghost:1b"], chatStatus: 500 });
    await Promise.all([live.start(), dead.start(), broken.start()]);
  });
  after(async () => { await Promise.all([live.stop(), dead.stop(), broken.stop()]); });

  test("fetchTags enumerates live, null on failing host", async () => {
    assert.deepEqual((await fetchTags(live.baseUrl))?.sort(), ["llama3.1:8b", "qwen2.5:7b"]);
    assert.equal(await fetchTags(dead.baseUrl), null);
  });

  test("verifyModel ok on live, fail on broken chat", async () => {
    const good = await verifyModel(live.baseUrl, "llama3.1:8b");
    assert.equal(good.ok, true);
    assert.ok(good.latencyMs >= 0);
    const bad = await verifyModel(broken.baseUrl, "ghost:1b");
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /chat_http_500/);
  });

  test("canary rejects honeypot/fake endpoints (live but wrong answer)", async () => {
    const fake = new FakeOllama({ models: ["Qwen/Qwen3-Coder-480B"], reply: "I'd be happy to help with that.", ignoreCanary: true });
    await fake.start();
    const r = await verifyModel(fake.baseUrl, "Qwen/Qwen3-Coder-480B");
    assert.equal(r.ok, false);
    assert.equal(r.detail, "canary_failed");
    // A real model that computes the sum passes.
    assert.equal((await verifyModel(live.baseUrl, "llama3.1:8b")).ok, true);
    await fake.stop();
  });

  test("reconFleet returns only endpoints with verified models", async () => {
    const hosts = [
      { host: "127.0.0.1", port: live.port },
      { host: "127.0.0.1", port: dead.port },
      { host: "127.0.0.1", port: broken.port },
    ];
    const out = await reconFleet(hosts, { concurrency: 5, verifyAll: true });
    assert.equal(out.length, 1, "only the live endpoint qualifies");
    assert.equal(out[0]!.port, live.port);
    assert.equal(out[0]!.models.filter((m) => m.verified).length, 2);
  });

  test("verifyModel times out cleanly on a slow host", async () => {
    const slow = new FakeOllama({ models: ["x:1b"], latencyMs: 200 });
    await slow.start();
    const r = await verifyModel(slow.baseUrl, "x:1b", { timeoutMs: 50 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /chat_error/);
    await slow.stop();
  });
});
