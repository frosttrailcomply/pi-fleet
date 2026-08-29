import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, tokenize } from "../src/engine/memory/store.ts";
import { SelfImprovement, errorSignature } from "../src/engine/memory/improve.ts";

describe("memory store", () => {
  test("remember + retrieve by lexical relevance", () => {
    const s = new MemoryStore(":memory:");
    s.remember({ kind: "pitfall", text: "npm install fails behind corporate proxy without HTTPS_PROXY set", tags: ["npm"], context: "npm", weight: 1 });
    s.remember({ kind: "env-fact", text: "The database runs on port 5432 in the podman network", tags: ["db"], context: "db", weight: 1 });
    const hits = s.retrieve({ text: "why does npm install hang on proxy", topK: 3, minScore: 0.05 });
    assert.ok(hits.length >= 1);
    assert.match(hits[0]!.text, /npm install fails/);
  });

  test("dedup reinforces weight on near-duplicate", () => {
    const s = new MemoryStore(":memory:");
    const id1 = s.remember({ kind: "pitfall", text: "port 8080 already in use", tags: [], context: "net", weight: 1 });
    const id2 = s.remember({ kind: "pitfall", text: "port 8080 already in use", tags: [], context: "net", weight: 1 });
    assert.equal(id1, id2, "same signature -> same row");
    assert.equal(s.count(), 1);
    assert.ok(s.all()[0]!.weight > 1, "weight reinforced");
  });

  test("tag match boosts score", () => {
    const s = new MemoryStore(":memory:");
    s.remember({ kind: "lesson", text: "use bounded concurrency for network fanout", tags: ["network", "perf"], context: "", weight: 1 });
    const withTag = s.retrieve({ text: "fanout concurrency", tags: ["perf"], minScore: 0.01 });
    assert.ok(withTag[0]!.score > 0);
  });

  test("retrieve marks lessons used", () => {
    const s = new MemoryStore(":memory:");
    s.remember({ kind: "lesson", text: "always pin exact versions", tags: [], context: "", weight: 1 });
    s.retrieve({ text: "pin versions", minScore: 0.01 });
    assert.equal(s.all()[0]!.uses, 1);
  });

  test("tokenize drops stopwords, keeps paths", () => {
    const t = tokenize("The error is in src/engine/router.ts on line 42");
    assert.ok(t.includes("src/engine/router.ts"));
    assert.ok(!t.includes("the"));
  });
});

describe("error signature normalization", () => {
  test("strips volatile numbers/hex/quoted", () => {
    const a = errorSignature('ECONNREFUSED 127.0.0.1:51234 at 0xdeadbeef "session-abc"');
    const b = errorSignature('ECONNREFUSED 10.0.0.5:9999 at 0xcafef00d "session-xyz"');
    assert.equal(a, b, "volatile bits normalized to a stable signature");
  });
});

describe("self-improvement observer", () => {
  test("emits pitfall lesson after repeated tool failure", () => {
    const s = new MemoryStore(":memory:");
    const si = new SelfImprovement(s, 2);
    const o = { tool: "bash", ok: false, errorSignature: "command not found: rg", detail: "grep alt" };
    si.observeTool(o); // streak 1, no lesson yet
    assert.equal(s.count(), 0);
    si.observeTool(o); // streak 2 -> pitfall
    assert.equal(s.count(), 1);
    assert.equal(s.all()[0]!.kind, "pitfall");
  });

  test("emits workaround lesson when a failing tool later succeeds", () => {
    const s = new MemoryStore(":memory:");
    const si = new SelfImprovement(s, 2);
    si.observeTool({ tool: "bash", ok: false, errorSignature: "command not found: rg" });
    si.observeTool({ tool: "bash", ok: false, errorSignature: "command not found: rg" });
    si.observeTool({ tool: "bash", ok: true, detail: "used grep instead" });
    const kinds = s.all().map((l) => l.kind);
    assert.ok(kinds.includes("workaround"), "workaround captured");
  });

  test("renderLessons produces an injectable block", () => {
    const s = new MemoryStore(":memory:");
    s.remember({ kind: "env-fact", text: "podman socket at /run/podman.sock", tags: [], context: "", weight: 1 });
    const block = SelfImprovement.renderLessons(s.retrieve({ text: "podman socket", minScore: 0.01 }));
    assert.match(block, /pi-fleet memory/);
    assert.match(block, /podman socket/);
  });
});
