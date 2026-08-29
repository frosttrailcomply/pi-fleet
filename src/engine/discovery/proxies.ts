// Rotating free-proxy pool backed by proxifly's public list
// (github.com/proxifly/free-proxy-list, served over CDN).
//
// Free proxies are mostly dead, so the pool's whole job is to keep only
// *validated working* ones: it fetches the list, tests each candidate against a
// small always-on endpoint, and rotates over the survivors (fastest first).
// Rotating the scrape's exit IP keeps repeated Censys pulls from tripping the
// anonymous rate limit. The list fetch and the validator are injectable so the
// pool is fully unit-testable without network.

import { request as httpRequest } from "node:http";
import type { ProxyConfig } from "../types.ts";

export interface ProxyRecord {
  proxy: string; // e.g. "http://1.2.3.4:8080"
  protocol: string;
  ip: string;
  port: number;
}

export interface WorkingProxy extends ProxyRecord {
  latencyMs: number;
}

/** Validate an HTTP proxy by proxying a GET to `targetUrl` (absolute-URI form). */
export function checkHttpProxy(proxyHost: string, proxyPort: number, targetUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    let target: URL;
    try { target = new URL(targetUrl); } catch { return finish(false); }
    const req = httpRequest(
      { host: proxyHost, port: proxyPort, method: "GET", path: targetUrl, headers: { Host: target.host, "User-Agent": "pi-fleet-proxy-check", Connection: "close" } },
      (res) => { const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 400; res.resume(); finish(ok); },
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(false); });
    req.on("error", () => finish(false));
    req.end();
  });
}

/** Parse one `ip:port` or `scheme://ip:port` line into a record. */
function parseProxyLine(line: string, defaultProto: string): ProxyRecord | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  let proto = defaultProto, hostPort = s;
  const m = s.match(/^([a-z0-9]+):\/\/(.+)$/i);
  if (m) { proto = m[1]!.toLowerCase(); hostPort = m[2]!; }
  const at = hostPort.lastIndexOf("@"); // strip user:pass@
  if (at !== -1) hostPort = hostPort.slice(at + 1);
  const i = hostPort.lastIndexOf(":");
  if (i === -1) return null;
  const ip = hostPort.slice(0, i);
  const port = Number(hostPort.slice(i + 1));
  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { proxy: `${proto}://${ip}:${port}`, protocol: proto, ip, port };
}

/** Auto-detect a source body: JSON array (records or strings) or newline text. */
export function parseProxySource(text: string, defaultProto: string): ProxyRecord[] {
  const out: ProxyRecord[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      for (const el of arr) {
        if (typeof el === "string") { const r = parseProxyLine(el, defaultProto); if (r) out.push(r); }
        else if (el && typeof el === "object") {
          const o = el as Partial<ProxyRecord>;
          if (typeof o.ip === "string" && typeof o.port === "number") {
            const protocol = (o.protocol as string) || defaultProto;
            out.push({ proxy: o.proxy || `${protocol}://${o.ip}:${o.port}`, protocol, ip: o.ip, port: o.port });
          }
        }
      }
      return out;
    } catch {
      /* fall through to text parsing */
    }
  }
  for (const line of trimmed.split(/\r?\n/)) { const r = parseProxyLine(line, defaultProto); if (r) out.push(r); }
  return out;
}

export type ProxyValidator = (p: ProxyRecord) => Promise<{ ok: boolean; latencyMs: number }>;

export interface ProxyPoolDeps {
  fetchImpl?: typeof fetch;
  /** Override validation (tests). Default: HTTP proxy check against validateUrl. */
  validator?: ProxyValidator;
  now?: () => number;
}

/** Bounded-concurrency map. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
      while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
    }),
  );
  return out;
}

export class ProxyPool {
  private working: WorkingProxy[] = [];
  private cursor = 0;
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly validate: ProxyValidator;

  constructor(private cfg: ProxyConfig, private deps: ProxyPoolDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.validate =
      deps.validator ??
      (async (p) => {
        const started = Date.now();
        const ok = await checkHttpProxy(p.ip, p.port, this.cfg.validateUrl, this.cfg.validateTimeoutMs);
        return { ok, latencyMs: Date.now() - started };
      });
  }

  /** Number of currently-known working proxies. */
  size(): number { return this.working.length; }

  list(): WorkingProxy[] { return [...this.working]; }

  /** Fetch every source, parse (JSON records or text lines), dedupe, filter. */
  private async fetchList(): Promise<ProxyRecord[]> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const allowed = new Set(this.cfg.protocols);
    const byKey = new Map<string, ProxyRecord>();
    const defaultProto = this.cfg.protocols[0] ?? "http";

    await Promise.all(
      this.cfg.sources.map(async (url) => {
        let text: string;
        try {
          const res = await doFetch(url);
          if (!res.ok) return;
          text = await res.text();
        } catch {
          return;
        }
        for (const rec of parseProxySource(text, defaultProto)) {
          if (allowed.has(rec.protocol as never)) byKey.set(`${rec.ip}:${rec.port}`, rec);
        }
      }),
    );
    return [...byKey.values()];
  }

  /** Fetch + validate; replace the working set with survivors (fastest first). */
  async refresh(): Promise<void> {
    if (!this.cfg.enabled) { this.working = []; return; }
    const candidates = await this.fetchList();
    const results = await pool(candidates, this.cfg.concurrency, async (p) => {
      const v = await this.validate(p);
      return v.ok ? ({ ...p, latencyMs: v.latencyMs } as WorkingProxy) : null;
    });
    this.working = results
      .filter((r): r is WorkingProxy => r !== null)
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .slice(0, this.cfg.maxProxies);
    this.cursor = 0;
    this.lastRefresh = this.now();
  }

  /** Refresh only if disabled-guarded, empty, or the interval has elapsed (deduped). */
  async ensureFresh(): Promise<void> {
    if (!this.cfg.enabled) return;
    const stale = this.now() - this.lastRefresh >= this.cfg.refreshIntervalMs;
    if (this.working.length > 0 && !stale) return;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    await this.refreshing;
  }

  /** Next working proxy URL (round-robin), or null if none. */
  next(): string | null {
    if (this.working.length === 0) return null;
    const p = this.working[this.cursor % this.working.length]!;
    this.cursor++;
    return p.proxy;
  }

  /** Drop a proxy that just failed at call time so it isn't reused. */
  drop(proxyUrl: string): void {
    this.working = this.working.filter((p) => p.proxy !== proxyUrl);
  }
}
