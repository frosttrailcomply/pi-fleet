// FleetOrchestrator ties every engine part together behind one small surface,
// with no dependency on pi. The pi extension adapter (src/ext) and the CLI
// (src/cli) both drive this same object, and the E2E suite tests it directly.

import type { FleetConfig, ChatRequest, ModelInfo, Endpoint } from "./types.ts";
import { resolveSecret } from "./config.ts";
import { FleetRegistry } from "./registry.ts";
import { Router } from "./routing/router.ts";
import { FailoverExecutor } from "./routing/executor.ts";
import { FleetRefresher, type RefresherDeps } from "./discovery/refresher.ts";
import { MoaOrchestrator, type MoaResult } from "./moa/moa.ts";
import { MemoryStore, type ScoredLesson } from "./memory/store.ts";
import { SelfImprovement, type ToolOutcome } from "./memory/improve.ts";
import { EvolutionEngine, type Evaluator, type GitRunner, type CycleOutcome } from "./memory/evolve.ts";
import { HindsightBackend } from "./memory/hindsight.ts";

export interface OrchestratorDeps {
  fetchImpl?: typeof fetch;
  refresher?: RefresherDeps;
  git?: GitRunner;
  now?: () => number;
  /** Skip opening the sqlite memory db (tests that don't need it). */
  memoryDbPath?: string;
  /** Inject a pre-built Hindsight backend (tests); else built from config. */
  hindsight?: HindsightBackend;
}

export interface FleetStatus {
  endpoints: Array<{ id: string; health: string; breaker: string; models: number; latencyMs: number; reliability: number; source: string }>;
  totalModels: number;
  moaEnabled: boolean;
  memoryLessons: number;
  memoryBackend: string;
  evolutionEnabled: boolean;
}

export class FleetOrchestrator {
  readonly registry: FleetRegistry;
  readonly router: Router;
  readonly executor: FailoverExecutor;
  readonly refresher: FleetRefresher;
  readonly moa: MoaOrchestrator;
  readonly memory: MemoryStore | null;
  readonly improvement: SelfImprovement | null;
  readonly evolution: EvolutionEngine | null;
  /** Optional remote memory backend (Hindsight). Used for retrieval + retain
   *  when reachable; the native store always runs and drives self-evolution. */
  remote: HindsightBackend | null = null;
  private evoTimer?: ReturnType<typeof setInterval>;

  constructor(public cfg: FleetConfig, private deps: OrchestratorDeps = {}) {
    this.registry = new FleetRegistry(cfg.health, deps.now);
    this.router = new Router(this.registry, cfg.routing);
    this.executor = new FailoverExecutor(this.registry, this.router, (id) => this.connFor(id));
    this.refresher = new FleetRefresher(this.registry, cfg.discovery, cfg.health, deps.refresher ?? { fetchImpl: deps.fetchImpl });
    this.moa = new MoaOrchestrator(cfg.moa, this.router, this.executor);

    if (cfg.memory.enabled) {
      // The native local-first store is always present: it powers self-evolution
      // and is the guaranteed fallback when the preferred backend is unreachable.
      this.memory = new MemoryStore(deps.memoryDbPath ?? cfg.memory.dbPath, deps.now);
      this.improvement = new SelfImprovement(this.memory);
      this.evolution = new EvolutionEngine(cfg.evolution, cfg, this.registry, this.router, this.memory, deps.git);
      if (cfg.memory.backend === "hindsight") {
        this.remote = deps.hindsight ?? new HindsightBackend(cfg.memory.hindsight, { fetchImpl: deps.fetchImpl });
      }
    } else {
      this.memory = null;
      this.improvement = null;
      this.evolution = null;
    }
  }

  /** Probe the preferred remote backend; on failure fall back to native. */
  async initMemoryBackend(): Promise<void> {
    if (!this.remote) return;
    const ready = await this.remote.probe().catch(() => false);
    if (!ready) {
      if (!this.cfg.memory.fallbackToNative) {
        console.error("[pi-fleet] Hindsight unreachable and fallbackToNative=false; memory retrieval disabled");
      }
      this.remote = null; // fall back to native
    }
  }

  /** Register statically configured providers as endpoints in the fleet pool. */
  init(): void {
    for (const p of this.cfg.providers) {
      const models: ModelInfo[] = p.models.map((m) => ({
        id: m.id, sizeB: m.sizeB ?? 0, contextWindow: m.contextWindow ?? 8192, verified: true,
      }));
      const ep: Endpoint = {
        id: p.id, host: p.id, port: 0, baseUrl: p.baseUrl.replace(/\/$/, ""),
        api: p.api ?? "openai-completions", source: "config",
        apiKey: resolveSecret(p.apiKey), models, firstSeen: 0, lastSeen: 0,
      };
      this.registry.upsert(ep);
    }
  }

  /** Resolve the base URL + key used to call an endpoint. */
  connFor(endpointId: string): { baseUrl: string; apiKey?: string } | null {
    const rec = this.registry.get(endpointId);
    if (!rec) return null;
    return { baseUrl: rec.endpoint.baseUrl, apiKey: rec.endpoint.apiKey };
  }

  /** Route a request to the best endpoint with transparent failover. */
  async chat(req: ChatRequest) {
    return this.executor.execute(req, { timeoutMs: this.cfg.health.requestTimeoutMs, fetchImpl: this.deps.fetchImpl });
  }

  /** Run the MoA pipeline. Throws if too few workers succeed (caller may fall back to chat). */
  async moaChat(req: ChatRequest): Promise<MoaResult> {
    return this.moa.run(req);
  }

  /** Virtual + discovered models to advertise to pi's model registry. */
  listModels(): Array<{ id: string; name: string; contextWindow: number; sizeB: number }> {
    const out: Array<{ id: string; name: string; contextWindow: number; sizeB: number }> = [
      { id: "auto", name: "Fleet (auto-route)", contextWindow: 131072, sizeB: 0 },
    ];
    if (this.cfg.moa.enabled) out.push({ id: "moa", name: "Fleet (Mixture of Agents)", contextWindow: 131072, sizeB: 0 });
    for (const rec of this.registry.all()) {
      for (const m of rec.endpoint.models) {
        if (!m.verified) continue;
        out.push({ id: `${rec.endpoint.id}/${m.id}`, name: `${m.id} @ ${rec.endpoint.id}`, contextWindow: m.contextWindow, sizeB: m.sizeB });
      }
    }
    return out;
  }

  status(): FleetStatus {
    const endpoints = this.registry.all().map((r) => ({
      id: r.endpoint.id, health: r.health, breaker: r.breaker,
      models: r.endpoint.models.filter((m) => m.verified).length,
      latencyMs: Math.round(r.stats.latencyMs), reliability: Number(this.registry.reliability(r.endpoint.id).toFixed(2)),
      source: r.endpoint.source,
    }));
    return {
      endpoints,
      totalModels: endpoints.reduce((a, e) => a + e.models, 0),
      moaEnabled: this.cfg.moa.enabled,
      memoryLessons: this.memory?.count() ?? 0,
      memoryBackend: this.remote?.ready() ? "hindsight" : (this.cfg.memory.enabled ? "native" : "disabled"),
      evolutionEnabled: this.cfg.evolution.enabled,
    };
  }

  /** Which memory backend is actually active right now. */
  activeMemoryBackend(): "hindsight" | "native" | "disabled" {
    if (!this.cfg.memory.enabled) return "disabled";
    return this.remote?.ready() ? "hindsight" : "native";
  }

  /**
   * Feed a tool outcome into memory. The native self-improvement observer always
   * runs (it drives self-evolution); when the Hindsight backend is active the
   * outcome is also retained there for richer consolidation.
   */
  observeTool(o: ToolOutcome): void {
    this.improvement?.observeTool(o);
    if (this.remote?.ready()) void this.remote.retainToolOutcome(o);
  }

  /** Record an explicit fact/lesson into the active backend(s). */
  note(kind: "lesson" | "env-fact", text: string, tags: string[] = [], context = ""): void {
    this.improvement?.note(kind, text, tags, context);
    if (this.remote?.ready()) void this.remote.retain({ kind, text, tags, context });
  }

  /**
   * Retrieve lessons relevant to a prompt for injection. Reads from the active
   * backend (Hindsight when reachable, else the native store).
   */
  async retrieveLessons(prompt: string, tags: string[] = []): Promise<ScoredLesson[]> {
    if (this.remote?.ready()) return this.remote.retrieve(prompt, tags, this.cfg.memory.topK, this.cfg.memory.minScore);
    if (!this.improvement) return [];
    return this.improvement.retrieveForPrompt(prompt, tags, this.cfg.memory.topK, this.cfg.memory.minScore);
  }

  /** Default evolution evaluator: mean reliability of the current fleet. Higher is better. */
  defaultEvaluator: Evaluator = () => {
    const recs = this.registry.all();
    return recs.length ? recs.reduce((a, r) => a + this.registry.reliability(r.endpoint.id), 0) / recs.length : 0;
  };

  runEvolution(evaluator?: Evaluator): CycleOutcome[] {
    if (!this.evolution || !this.cfg.evolution.enabled) return [];
    return this.evolution.runCycle(evaluator ?? this.defaultEvaluator);
  }

  /** Start background loops (discovery/health + evolution). Idempotent. */
  async start(): Promise<void> {
    this.init();
    await this.initMemoryBackend();
    await this.refresher.start();
    if (this.evolution && this.cfg.evolution.enabled) {
      const si = this.deps.refresher?.setInterval ?? setInterval;
      this.evoTimer = si(() => this.runEvolution(), this.cfg.evolution.intervalMs);
      this.evoTimer.unref?.();
    }
  }

  stop(): void {
    this.refresher.stop();
    if (this.evoTimer) (this.deps.refresher?.clearInterval ?? clearInterval)(this.evoTimer);
    this.evoTimer = undefined;
    this.memory?.close();
  }
}
