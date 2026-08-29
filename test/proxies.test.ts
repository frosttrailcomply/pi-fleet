import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ProxyPool, checkHttpProxy, parseProxySource, type ProxyRecord } from "../src/engine/discovery/proxies.ts";
import { FleetRegistry } from "../src/engine/registry.ts";
import { FleetRefresher } from "../src/engine/discovery/refresher.ts";
import { DEFAULT_CONFIG } from "../src/engine/config.ts";
import type { ProxyConfig } from "../src/engine/types.ts";
import type { CommandRunner } from "../src/engine/discovery/browser.ts";

function cfg(over: Partial<ProxyConfig> = {}): ProxyConfig {
  return { ...structuredClone(DEFAULT_CONFIG.discovery.censys.proxy), enabled: true, ...over };
}

const LIST: ProxyRecord[] = [
  { proxy: "http://1.1.1.1:8080", protocol: "http", ip: "1.1.1.1", port: 8080 },
  { proxy: "http://2.2.2.2:3128", protocol: "http", ip: "2.2.2.2", port: 3128 },
  { proxy: "http://3.3.3.3:80", protocol: "http", ip: "3.3.3.3", port: 80 },
  { proxy: "socks5://4.4.4.4:1080", protocol: "socks5", ip: "4.4.4.4", port: 1080 },
];

function listFetch(records = LIST): typeof fetch {
  return (async () => new Response(JSON.stringify(records), { status: 200 })) as unknown as typeof fetch;
}

describe("ProxyPool: validation keeps only working proxies", () => {
  test("filters by protocol, drops dead, sorts fastest-first, caps", async () => {
    const dead = new Set(["2.2.2.2"]);
    const p = new ProxyPool(cfg({ maxProxies: 2 }), {
      fetchImpl: listFetch(),
      validator: async (r) => ({ ok: !dead.has(r.ip), latencyMs: r.port }), // latency = port for determinism
    });
    await p.refresh();
    const ips = p.list().map((w) => w.ip);
    assert.deepEqual(ips, ["3.3.3.3", "1.1.1.1"], "http only, 2.2.2.2 dropped, sorted by latency, capped to 2");
    assert.ok(!p.list().some((w) => w.protocol === "socks5"), "socks5 excluded by protocol filter");
  });

  test("next() rotates round-robin; drop() removes", async () => {
    const p = new ProxyPool(cfg(), { fetchImpl: listFetch(), validator: async (r) => ({ ok: true, latencyMs: r.port }) });
    await p.refresh();
    const a = p.next(), b = p.next(), c = p.next(), d = p.next();
    assert.notEqual(a, b);
    assert.equal(a, d, "wraps around after exhausting the set of 3 http proxies");
    p.drop(a!);
    assert.ok(!p.list().some((w) => w.proxy === a));
  });

  test("disabled pool stays empty; next() null", async () => {
    const p = new ProxyPool(cfg({ enabled: false }), { fetchImpl: listFetch(), validator: async () => ({ ok: true, latencyMs: 1 }) });
    await p.ensureFresh();
    assert.equal(p.size(), 0);
    assert.equal(p.next(), null);
  });

  test("ensureFresh refreshes once then caches until stale", async () => {
    let fetches = 0;
    const fetchImpl = (async () => { fetches++; return new Response(JSON.stringify(LIST), { status: 200 }); }) as unknown as typeof fetch;
    let clock = 0;
    const p = new ProxyPool(cfg({ sources: ["u1"], refreshIntervalMs: 1000 }), { fetchImpl, validator: async () => ({ ok: true, latencyMs: 1 }), now: () => clock });
    await p.ensureFresh(); await p.ensureFresh();
    assert.equal(fetches, 1, "cached, not re-fetched");
    clock += 1000;
    await p.ensureFresh();
    assert.equal(fetches, 2, "re-fetched after interval");
  });

  test("empty/failed list yields no working proxies (graceful)", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const p = new ProxyPool(cfg(), { fetchImpl: bad, validator: async () => ({ ok: true, latencyMs: 1 }) });
    await p.refresh();
    assert.equal(p.size(), 0);
  });
});

describe("parseProxySource: JSON records + text lines", () => {
  test("proxifly JSON records", () => {
    const recs = parseProxySource(JSON.stringify([{ proxy: "http://1.2.3.4:8080", protocol: "http", ip: "1.2.3.4", port: 8080 }]), "http");
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.ip, "1.2.3.4");
  });
  test("ProxyGenerator ip:port text lines", () => {
    const recs = parseProxySource("137.31.47.73:80\n# comment\n2.26.87.216:1080\n\nbad-line\n", "http");
    assert.deepEqual(recs.map((r) => `${r.ip}:${r.port}`), ["137.31.47.73:80", "2.26.87.216:1080"]);
    assert.equal(recs[0]!.protocol, "http");
    assert.equal(recs[0]!.proxy, "http://137.31.47.73:80");
  });
  test("scheme://user:pass@host:port and JSON string arrays", () => {
    assert.equal(parseProxySource("socks5://u:p@9.9.9.9:1080", "http")[0]!.protocol, "socks5");
    assert.equal(parseProxySource("socks5://u:p@9.9.9.9:1080", "http")[0]!.ip, "9.9.9.9");
    assert.equal(parseProxySource(JSON.stringify(["5.5.5.5:3128"]), "http")[0]!.port, 3128);
  });
});

describe("ProxyPool merges multiple sources (proxifly JSON + ProxyGenerator text)", () => {
  test("dedupes across sources, applies protocol filter", async () => {
    const jsonSrc = JSON.stringify([{ proxy: "http://1.1.1.1:8080", protocol: "http", ip: "1.1.1.1", port: 8080 }]);
    const textSrc = "1.1.1.1:8080\n7.7.7.7:80\nsocks5://8.8.8.8:1080\n";
    const fetchImpl = (async (u: string) => new Response(String(u).endsWith(".txt") ? textSrc : jsonSrc, { status: 200 })) as unknown as typeof fetch;
    const p = new ProxyPool(cfg({ sources: ["https://a/list.json", "https://b/list.txt"] }), { fetchImpl, validator: async () => ({ ok: true, latencyMs: 1 }) });
    await p.refresh();
    const ips = p.list().map((w) => w.ip).sort();
    assert.deepEqual(ips, ["1.1.1.1", "7.7.7.7"], "1.1.1.1 deduped across sources; socks5 filtered out (http only)");
  });
});

describe("checkHttpProxy against a real local proxy", () => {
  let proxy: Server;
  let port = 0;
  before(async () => {
    proxy = createServer((req, res) => {
      // Absolute-URI request line is what an HTTP proxy receives.
      if (req.url === "http://t.local/generate_204") { res.writeHead(204).end(); }
      else { res.writeHead(500).end(); }
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    port = (proxy.address() as AddressInfo).port;
  });
  after(async () => { await new Promise<void>((r) => proxy.close(() => r())); });

  test("returns true when the proxy forwards to a 204 target", async () => {
    assert.equal(await checkHttpProxy("127.0.0.1", port, "http://t.local/generate_204", 3000), true);
  });
  test("returns false on connection refused / timeout", async () => {
    assert.equal(await checkHttpProxy("127.0.0.1", 1, "http://t.local/generate_204", 500), false);
  });
});

describe("refresher routes the scrape through a working proxy", () => {
  test("gatherCandidates forwards CENSYS_PROXY to the scrape command", async () => {
    const r = new FleetRegistry(DEFAULT_CONFIG.health);
    const disc = structuredClone(DEFAULT_CONFIG.discovery);
    disc.seeds = [];
    disc.censys = {
      ...disc.censys, enabled: true, htmlImports: [],
      browser: { ...disc.censys.browser, enabled: true, command: ["fake", "{url}"], resultPath: "" },
      proxy: cfg({ enabled: true }),
    };
    const sampleHtml = `<a title="View 9.9.9.9:11434 Details"></a>`;
    let seenEnv: Record<string, string> | undefined;
    const run: CommandRunner = async (_c, _a, _t, env) => { seenEnv = env; return { code: 0, stdout: sampleHtml, stderr: "" }; };
    const ref = new FleetRefresher(r, disc, DEFAULT_CONFIG.health, {
      commandRunner: run,
      proxyDeps: { fetchImpl: listFetch(), validator: async (rec) => ({ ok: rec.ip === "1.1.1.1", latencyMs: 1 }) },
    });
    const cands = await ref.gatherCandidates();
    assert.ok(cands.some((c) => c.host === "9.9.9.9"), "scrape still yields hosts");
    assert.equal(seenEnv?.CENSYS_PROXY, "http://1.1.1.1:8080", "only the validated working proxy is used");
  });
});
