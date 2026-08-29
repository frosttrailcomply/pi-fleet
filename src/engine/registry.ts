// The fleet registry: the single source of truth for known endpoints, their
// live models, rolling performance stats, and circuit-breaker state.
//
// The breaker is a standard three-state machine:
//   closed    -> normal; failures accumulate.
//   open       -> too many consecutive failures; calls are skipped until cooldown.
//   half-open  -> cooldown elapsed; a limited trial; successes close it, a
//                 failure re-opens it.
// Health is a projection of breaker + recent reliability for display/routing.

import type {
  Endpoint, EndpointRecord, HealthConfig, Stats, BreakerState, Health, ModelInfo,
} from "./types.ts";

function freshStats(): Stats {
  return {
    latencyMs: 0, throughputTps: 0, successes: 0, failures: 0,
    consecutiveFailures: 0, consecutiveSuccesses: 0, lastSuccess: 0, lastFailure: 0,
  };
}

/** EWMA update; seeds with the first sample. */
function ewma(prev: number, sample: number, alpha: number): number {
  return prev === 0 ? sample : prev * (1 - alpha) + sample * alpha;
}

export interface RegistrySnapshot {
  endpoints: EndpointRecord[];
  generatedAt: number;
}

export class FleetRegistry {
  private records = new Map<string, EndpointRecord>();
  constructor(private cfg: HealthConfig, private now: () => number = Date.now) {}

  /** Insert or merge an endpoint. Preserves existing stats/breaker on update. */
  upsert(ep: Endpoint): EndpointRecord {
    const existing = this.records.get(ep.id);
    if (existing) {
      // Merge model lists (verified wins), refresh lastSeen.
      const byId = new Map<string, ModelInfo>();
      for (const m of existing.endpoint.models) byId.set(m.id, m);
      for (const m of ep.models) {
        const prev = byId.get(m.id);
        byId.set(m.id, prev ? { ...prev, ...m, verified: prev.verified || m.verified } : m);
      }
      existing.endpoint = { ...existing.endpoint, ...ep, models: [...byId.values()], firstSeen: existing.endpoint.firstSeen, lastSeen: this.now() };
      return existing;
    }
    const rec: EndpointRecord = {
      endpoint: { ...ep, firstSeen: ep.firstSeen || this.now(), lastSeen: this.now() },
      stats: freshStats(),
      breaker: "closed",
      openedAt: 0,
      health: "healthy",
    };
    this.records.set(ep.id, rec);
    return rec;
  }

  remove(id: string): boolean {
    return this.records.delete(id);
  }

  get(id: string): EndpointRecord | undefined {
    return this.records.get(id);
  }

  all(): EndpointRecord[] {
    return [...this.records.values()];
  }

  snapshot(): RegistrySnapshot {
    return { endpoints: this.all().map((r) => structuredClone(r)), generatedAt: this.now() };
  }

  /** Record a successful call and update rolling stats + breaker. */
  recordSuccess(id: string, latencyMs: number, tokens = 0): void {
    const rec = this.records.get(id);
    if (!rec) return;
    const s = rec.stats;
    s.successes++;
    s.consecutiveSuccesses++;
    s.consecutiveFailures = 0;
    s.lastSuccess = this.now();
    s.latencyMs = ewma(s.latencyMs, latencyMs, this.cfg.ewmaAlpha);
    if (tokens > 0 && latencyMs > 0) {
      s.throughputTps = ewma(s.throughputTps, (tokens / latencyMs) * 1000, this.cfg.ewmaAlpha);
    }
    if (rec.breaker === "half-open" && s.consecutiveSuccesses >= this.cfg.recoveryThreshold) {
      rec.breaker = "closed";
    }
    this.refreshHealth(rec);
  }

  /** Record a failed call and trip the breaker if the threshold is reached. */
  recordFailure(id: string, latencyMs = 0): void {
    const rec = this.records.get(id);
    if (!rec) return;
    const s = rec.stats;
    s.failures++;
    s.consecutiveFailures++;
    s.consecutiveSuccesses = 0;
    s.lastFailure = this.now();
    if (latencyMs > 0) s.latencyMs = ewma(s.latencyMs, latencyMs, this.cfg.ewmaAlpha);
    // A failure during a half-open trial immediately re-opens.
    if (rec.breaker === "half-open" || s.consecutiveFailures >= this.cfg.failureThreshold) {
      rec.breaker = "open";
      rec.openedAt = this.now();
    }
    this.refreshHealth(rec);
  }

  /**
   * Whether a call may be attempted now. Transitions open -> half-open once the
   * cooldown has elapsed (a side effect, so the trial is granted exactly once
   * per cooldown window before the next call resolves it).
   */
  isAvailable(id: string): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    if (rec.breaker === "open") {
      if (this.now() - rec.openedAt >= this.cfg.cooldownMs) {
        rec.breaker = "half-open";
        rec.stats.consecutiveSuccesses = 0;
        this.refreshHealth(rec);
        return true;
      }
      return false;
    }
    return true; // closed or half-open
  }

  /** Recompute the health projection from breaker + reliability. */
  private refreshHealth(rec: EndpointRecord): void {
    rec.health = this.deriveHealth(rec);
  }

  private deriveHealth(rec: EndpointRecord): Health {
    // Health tracks *recent* state so an endpoint that has just recovered reads
    // healthy again. Lifetime success rate feeds routing via reliability(),
    // not this projection.
    if (rec.breaker === "open") return "unhealthy";
    if (rec.breaker === "half-open") return "degraded";
    return rec.stats.consecutiveFailures > 0 ? "degraded" : "healthy";
  }

  /** Reliability score in [0,1] weighted toward recent behavior. */
  reliability(id: string): number {
    const rec = this.records.get(id);
    if (!rec) return 0;
    const { successes, failures, consecutiveFailures } = rec.stats;
    const total = successes + failures;
    const base = total === 0 ? 0.7 : successes / total; // unknown endpoints get a neutral-optimistic prior
    const penalty = Math.min(0.5, consecutiveFailures * 0.15);
    return Math.max(0, base - penalty);
  }
}
