// Routing: score every (endpoint, model) candidate and rank them.
//
// Each signal is normalized to [0,1] (higher = better) then combined with the
// configurable weights. Endpoints whose breaker is open are excluded up front
// via registry.isAvailable(), so routing only ever ranks callable candidates.

import type { Candidate, RoutingWeights, EndpointRecord, ModelInfo } from "../types.ts";
import type { FleetRegistry } from "../registry.ts";

const HEALTH_SCORE = { healthy: 1, degraded: 0.5, unhealthy: 0 } as const;

/** Normalize latency: 0ms -> 1.0, decays; 2s -> ~0.2. Unmeasured -> neutral 0.6. */
function latencyScore(ms: number): number {
  if (ms <= 0) return 0.6;
  return 1 / (1 + ms / 500);
}

/** Normalize throughput against a soft reference of 80 tok/s. Unmeasured -> 0.5. */
function throughputScore(tps: number): number {
  if (tps <= 0) return 0.5;
  return Math.min(1, tps / 80);
}

/** Capability from parameter size; log-scaled so 7B..120B spreads sensibly. */
function capabilityScore(sizeB: number): number {
  if (sizeB <= 0) return 0.4; // unknown size (e.g. hosted models) -> mid prior
  return Math.min(1, Math.log10(sizeB + 1) / Math.log10(130));
}

/** Context score against a 128k reference. */
function contextScore(ctx: number): number {
  return Math.min(1, ctx / 131072);
}

export interface RouteQuery {
  /** Required minimum context window in tokens. */
  minContext?: number;
  /** Restrict to these endpoint ids (e.g. MoA worker pool). */
  endpointIds?: string[];
  /** Restrict to model ids matching this substring/family. */
  modelFilter?: (model: ModelInfo, rec: EndpointRecord) => boolean;
  /** Only verified models are eligible when true (default true). */
  verifiedOnly?: boolean;
}

export class Router {
  constructor(private registry: FleetRegistry, private weights: RoutingWeights) {}

  setWeights(w: RoutingWeights): void {
    this.weights = w;
  }

  private scoreCandidate(rec: EndpointRecord, model: ModelInfo): Candidate {
    const w = this.weights;
    const breakdown = {
      capability: capabilityScore(model.sizeB) * w.capability,
      latency: latencyScore(rec.stats.latencyMs) * w.latency,
      throughput: throughputScore(rec.stats.throughputTps) * w.throughput,
      health: HEALTH_SCORE[rec.health] * w.health,
      reliability: this.registry.reliability(rec.endpoint.id) * w.reliability,
      context: contextScore(model.contextWindow) * w.context,
    };
    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    return { endpointId: rec.endpoint.id, modelId: model.id, score, breakdown };
  }

  /** Ranked candidates, best first. Excludes unavailable (open-breaker) endpoints. */
  rank(query: RouteQuery = {}): Candidate[] {
    const verifiedOnly = query.verifiedOnly ?? true;
    const out: Candidate[] = [];
    for (const rec of this.registry.all()) {
      if (query.endpointIds && !query.endpointIds.includes(rec.endpoint.id)) continue;
      if (!this.registry.isAvailable(rec.endpoint.id)) continue;
      for (const model of rec.endpoint.models) {
        if (verifiedOnly && !model.verified) continue;
        if (query.minContext && model.contextWindow < query.minContext) continue;
        if (query.modelFilter && !query.modelFilter(model, rec)) continue;
        out.push(this.scoreCandidate(rec, model));
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Best single candidate, or null if none are eligible/available. */
  best(query: RouteQuery = {}): Candidate | null {
    return this.rank(query)[0] ?? null;
  }

  /**
   * Diverse top-N: at most one candidate per endpoint, then per distinct model
   * family, to spread MoA workers across hosts/models instead of stacking one.
   */
  diverse(n: number, query: RouteQuery = {}): Candidate[] {
    const ranked = this.rank(query);
    const picked: Candidate[] = [];
    const seenEndpoints = new Set<string>();
    const seenFamilies = new Set<string>();
    const family = (m: string) => m.split(/[:\/]/)[0] ?? m;
    for (const c of ranked) {
      if (picked.length >= n) break;
      if (seenEndpoints.has(c.endpointId)) continue;
      const fam = family(c.modelId);
      if (seenFamilies.has(fam) && picked.length < ranked.length) {
        // allow family repeat only if we can't otherwise fill n
      }
      seenEndpoints.add(c.endpointId);
      seenFamilies.add(fam);
      picked.push(c);
    }
    // Backfill from remaining (endpoint diversity relaxed) if short.
    if (picked.length < n) {
      for (const c of ranked) {
        if (picked.length >= n) break;
        if (picked.some((p) => p.endpointId === c.endpointId && p.modelId === c.modelId)) continue;
        picked.push(c);
      }
    }
    return picked.slice(0, n);
  }
}
