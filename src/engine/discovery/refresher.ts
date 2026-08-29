// Background fleet maintenance. Two independent timers:
//
//   full refresh  — gather candidate hosts (seeds + saved Censys HTML + Censys
//                   API), recon-probe them, upsert survivors into the registry.
//   health probe  — cheaply re-check already-known endpoints so the breaker can
//                   detect fresh outages and recover endpoints that came back.
//
// Timers are opt-in (start/stop) and never launched from an extension factory;
// the pi adapter starts them in session_start and stops them in shutdown. Clock
// and fetch are injectable so tests drive it deterministically without waiting.

import type { DiscoveryConfig, Endpoint, HealthConfig } from "../types.ts";
import type { FleetRegistry } from "../registry.ts";
import { extractFromFiles, queryCensys, censysCredsFromEnv, type HostPort } from "./censys.ts";
import { scrapeCensysViaBrowser, type CommandRunner } from "./browser.ts";
import { reconFleet, fetchTags } from "./probe.ts";

export interface RefresherDeps {
  fetchImpl?: typeof fetch;
  /** Override the browser-scrape command runner (tests inject a fake). */
  commandRunner?: CommandRunner;
  /** Override for tests; defaults to real timers. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (h: ReturnType<typeof setInterval>) => void;
}

export class FleetRefresher {
  private refreshTimer?: ReturnType<typeof setInterval>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private running = false;
  private onChange?: () => void;

  constructor(
    private registry: FleetRegistry,
    private discovery: DiscoveryConfig,
    private health: HealthConfig,
    private deps: RefresherDeps = {},
  ) {}

  /** Register a callback fired whenever the registry changes (adapter re-publishes models). */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** Parse a seed string ("host:port", "host", or "http://host:port") into HostPort. */
  private parseSeed(seed: string): HostPort[] {
    let s = seed.trim();
    if (!s) return [];
    if (s.startsWith("http")) {
      try {
        const u = new URL(s);
        return [{ host: u.hostname, port: Number(u.port) || this.discovery.defaultPorts[0] || 11434 }];
      } catch {
        return [];
      }
    }
    if (s.includes(":")) {
      const [host, p] = s.split(":");
      const port = Number(p);
      if (host && Number.isInteger(port)) return [{ host, port }];
    }
    return (this.discovery.defaultPorts.length ? this.discovery.defaultPorts : [11434]).map((port) => ({ host: s, port }));
  }

  /** Collect candidate host:port pairs from all configured sources. */
  async gatherCandidates(signal?: AbortSignal): Promise<HostPort[]> {
    const found = new Map<string, HostPort>();
    const add = (hp: HostPort) => found.set(`${hp.host}:${hp.port}`, hp);

    for (const seed of this.discovery.seeds) for (const hp of this.parseSeed(seed)) add(hp);

    const cx = this.discovery.censys;
    if (cx.enabled) {
      // Saved-HTML import path (credential-free).
      if (cx.htmlImports.length) {
        for (const hp of extractFromFiles(cx.htmlImports)) add(hp);
      }
      // Keyless live scrape via browser-search / CloakBrowser (default path).
      if (cx.browser.enabled) {
        for (const hp of await scrapeCensysViaBrowser(cx.browser, cx.query, { run: this.deps.commandRunner })) add(hp);
      }
      // Censys API when credentials are present (highest fidelity).
      const creds = censysCredsFromEnv(cx.apiIdEnv, cx.apiSecretEnv);
      if (creds) {
        for (const hp of await queryCensys(cx.query, creds, { signal, fetchImpl: this.deps.fetchImpl })) add(hp);
      }
    }
    return [...found.values()];
  }

  /** One full discovery pass: gather -> recon -> upsert. Returns endpoints added/updated. */
  async runFullRefresh(signal?: AbortSignal): Promise<number> {
    const candidates = await this.gatherCandidates(signal);
    if (candidates.length === 0) return 0;
    const discovered = await reconFleet(candidates, {
      concurrency: this.discovery.concurrency,
      timeoutMs: this.health.requestTimeoutMs,
      fetchImpl: this.deps.fetchImpl,
      signal,
    });
    for (const d of discovered) {
      const ep: Endpoint = {
        id: `${d.host}:${d.port}`, host: d.host, port: d.port, baseUrl: d.baseUrl,
        api: "ollama", source: "censys", models: d.models, firstSeen: 0, lastSeen: 0,
      };
      this.registry.upsert(ep);
    }
    if (discovered.length) this.onChange?.();
    return discovered.length;
  }

  /** One lightweight health pass over known endpoints (drives breaker recover/detect). */
  async runHealthProbe(signal?: AbortSignal): Promise<void> {
    const recs = this.registry.all();
    await Promise.all(
      recs.map(async (rec) => {
        // Only probe endpoints that are callable now (skips fully-open breakers
        // until their cooldown elapses; isAvailable flips them to half-open).
        if (!this.registry.isAvailable(rec.endpoint.id)) return;
        const started = Date.now();
        const tags = await fetchTags(rec.endpoint.baseUrl, {
          timeoutMs: this.health.requestTimeoutMs,
          fetchImpl: this.deps.fetchImpl,
          signal,
        });
        if (tags === null) {
          this.registry.recordFailure(rec.endpoint.id, Date.now() - started);
        } else {
          this.registry.recordSuccess(rec.endpoint.id, Date.now() - started, 0);
        }
      }),
    );
    this.onChange?.();
  }

  /** Start both timers (idempotent). Does an immediate first refresh. */
  async start(): Promise<void> {
    if (this.running || !this.discovery.enabled) return;
    this.running = true;
    const si = this.deps.setInterval ?? setInterval;
    // Kick an immediate refresh so the fleet is populated fast.
    await this.runFullRefresh().catch(() => {});
    this.refreshTimer = si(() => void this.runFullRefresh().catch(() => {}), this.discovery.refreshIntervalMs);
    this.healthTimer = si(() => void this.runHealthProbe().catch(() => {}), this.discovery.healthProbeIntervalMs);
    // Timers must not keep the process alive on their own.
    this.refreshTimer.unref?.();
    this.healthTimer.unref?.();
  }

  stop(): void {
    const ci = this.deps.clearInterval ?? clearInterval;
    if (this.refreshTimer) ci(this.refreshTimer);
    if (this.healthTimer) ci(this.healthTimer);
    this.refreshTimer = this.healthTimer = undefined;
    this.running = false;
  }
}
