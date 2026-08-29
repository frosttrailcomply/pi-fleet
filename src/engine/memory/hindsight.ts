// Optional Hindsight memory backend (github.com/vectorize-io/hindsight).
//
// Hindsight is the default *preferred* memory backend: it adds experience /
// observation consolidation (evidence-backed generalizations) and multi-path
// recall beyond what the native lexical store does. Because it is an external
// service (Docker + Postgres/pgvector), it is probed at startup and, when
// unreachable, the fleet transparently falls back to the native SQLite store —
// so the product always works out of the box, offline included.
//
// The REST surface below targets Hindsight's retain/recall API. Endpoint paths
// are intentionally small and may need adjusting per Hindsight version; every
// call is guarded and fetch is injectable for tests.

import type { HindsightConfig, Lesson } from "../types.ts";
import type { ScoredLesson } from "./store.ts";
import type { ToolOutcome } from "./improve.ts";
import { resolveSecret } from "../config.ts";

export interface HindsightDeps {
  fetchImpl?: typeof fetch;
}

export class HindsightBackend {
  private ok = false;
  private readonly fetch: typeof fetch;

  constructor(private cfg: HindsightConfig, deps: HindsightDeps = {}) {
    this.fetch = deps.fetchImpl ?? fetch;
  }

  ready(): boolean {
    return this.ok;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = resolveSecret(`$${this.cfg.apiKeyEnv}`);
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  private async call(path: string, init: RequestInit): Promise<Response | null> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      return await this.fetch(`${this.cfg.baseUrl}${path}`, { ...init, headers: this.headers(), signal: ac.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  /** Probe the service; sets ready() true on success. Returns readiness. */
  async probe(): Promise<boolean> {
    const res = await this.call("/health", { method: "GET" });
    this.ok = !!res && res.ok;
    return this.ok;
  }

  /** Retain a lesson/observation. Best-effort; never throws. */
  async retain(l: Pick<Lesson, "kind" | "text" | "tags" | "context">): Promise<void> {
    if (!this.ok) return;
    await this.call("/retain", {
      method: "POST",
      body: JSON.stringify({ namespace: this.cfg.namespace, kind: l.kind, text: l.text, tags: l.tags, context: l.context }),
    });
  }

  /** Retain a tool outcome as an experience (Hindsight consolidates these). */
  async retainToolOutcome(o: ToolOutcome): Promise<void> {
    if (!this.ok) return;
    const text = o.ok
      ? `Tool "${o.tool}" succeeded${o.detail ? `: ${o.detail}` : ""}`
      : `Tool "${o.tool}" failed: ${o.errorSignature ?? "unknown"}`;
    await this.retain({ kind: o.ok ? "lesson" : "failure", text, tags: [o.tool, o.ok ? "success" : "failure"], context: `${o.tool}|${o.errorSignature ?? ""}` });
  }

  /** Recall relevant lessons. Returns [] on any failure. */
  async retrieve(prompt: string, tags: string[], topK: number, minScore: number): Promise<ScoredLesson[]> {
    if (!this.ok) return [];
    const res = await this.call("/recall", {
      method: "POST",
      body: JSON.stringify({ namespace: this.cfg.namespace, query: prompt, tags, limit: topK, minScore }),
    });
    if (!res || !res.ok) return [];
    try {
      const body = (await res.json()) as { results?: Array<{ text?: string; kind?: string; tags?: string[]; context?: string; score?: number }> };
      return (body.results ?? [])
        .filter((r) => (r.score ?? 1) >= minScore && typeof r.text === "string")
        .slice(0, topK)
        .map((r) => ({
          kind: (r.kind as Lesson["kind"]) ?? "lesson",
          text: r.text as string,
          tags: r.tags ?? [],
          context: r.context ?? "",
          weight: 1,
          createdAt: 0,
          lastUsed: 0,
          uses: 0,
          score: r.score ?? 1,
        }));
    } catch {
      return [];
    }
  }
}
