// The failover executor turns a routed ranking into an actual answered request.
// It walks candidates best-first, calling each endpoint's OpenAI-compatible
// chat endpoint; a failure feeds the breaker and advances to the next
// candidate. Success feeds latency/throughput stats back into the registry.
//
// This is the shared call path used by the `fleet` virtual provider and by MoA
// workers, so routing/health/failover behave identically everywhere.

import type { ChatRequest, ChatResult, Candidate } from "../types.ts";
import type { FleetRegistry } from "../registry.ts";
import type { Router, RouteQuery } from "./router.ts";
import { verifyModelChat } from "./chat-call.ts";

export interface ExecuteOptions {
  query?: RouteQuery;
  /** Max candidates to try before giving up (default: all). */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Pin to a specific candidate (skip routing) — used for MoA workers. */
  pinned?: Candidate;
}

export interface ExecuteOutcome {
  result: ChatResult | null;
  attempts: Array<{ endpointId: string; modelId: string; ok: boolean; detail: string; latencyMs: number }>;
}

export class FailoverExecutor {
  constructor(
    private registry: FleetRegistry,
    private router: Router,
    private baseUrlFor: (endpointId: string) => { baseUrl: string; apiKey?: string } | null,
  ) {}

  /**
   * Answer `req` with transparent failover. Records stats/breaker transitions
   * for every attempt. Returns the first success plus a per-attempt log.
   */
  async execute(req: ChatRequest, opts: ExecuteOptions = {}): Promise<ExecuteOutcome> {
    const candidates = opts.pinned ? [opts.pinned] : this.router.rank(opts.query ?? {});
    const limit = opts.maxAttempts ?? candidates.length;
    const attempts: ExecuteOutcome["attempts"] = [];

    for (let i = 0; i < candidates.length && i < limit; i++) {
      const c = candidates[i]!;
      // Re-check availability at call time (breaker may have opened mid-loop).
      if (!opts.pinned && !this.registry.isAvailable(c.endpointId)) continue;
      const conn = this.baseUrlFor(c.endpointId);
      if (!conn) continue;

      const call = await verifyModelChat(conn.baseUrl, c.modelId, req, {
        apiKey: conn.apiKey,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
        signal: req.signal,
      });

      attempts.push({ endpointId: c.endpointId, modelId: c.modelId, ok: call.ok, detail: call.detail, latencyMs: call.latencyMs });

      if (call.ok) {
        this.registry.recordSuccess(c.endpointId, call.latencyMs, call.tokens);
        return {
          result: {
            content: call.content, endpointId: c.endpointId, modelId: c.modelId,
            latencyMs: call.latencyMs, tokens: call.tokens,
            throughputTps: call.latencyMs > 0 ? (call.tokens / call.latencyMs) * 1000 : 0,
          },
          attempts,
        };
      }
      this.registry.recordFailure(c.endpointId, call.latencyMs);
    }
    return { result: null, attempts };
  }
}
