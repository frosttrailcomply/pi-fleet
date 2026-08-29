// Mixture of Agents (MoA).
//
// Runs N independent worker models in parallel on the same prompt, then an
// aggregator model synthesizes their proposals into one answer. Workers and
// aggregator are routed through the same FailoverExecutor, so MoA works
// identically across discovered local endpoints and configured external
// providers, and each worker call still gets health-aware failover.
//
// Graceful degradation: if some workers fail, the aggregator runs on the
// survivors as long as >= minWorkers succeeded. If the aggregator itself
// fails, the single best worker proposal is returned as a fallback.

import type { ChatRequest, MoaConfig, Candidate } from "../types.ts";
import type { Router } from "../routing/router.ts";
import type { FailoverExecutor } from "../routing/executor.ts";

export interface MoaResult {
  content: string;
  aggregatorEndpoint: string | null;
  workerCount: number;
  succeededWorkers: number;
  usedFallback: boolean;
  workerModels: string[];
}

/** Resolve worker candidates: explicit ids if given, else auto by policy. */
function pickWorkers(cfg: MoaConfig, router: Router): Candidate[] {
  if (cfg.workerModels.length) {
    // Map "endpointId/modelId" specs onto ranked candidates.
    const ranked = router.rank();
    const out: Candidate[] = [];
    for (const spec of cfg.workerModels) {
      const [epId, modelId] = splitSpec(spec);
      const match = ranked.find((c) => c.endpointId === epId && (!modelId || c.modelId === modelId))
        ?? ranked.find((c) => c.modelId === (modelId ?? spec));
      if (match) out.push(match);
    }
    if (out.length) return out.slice(0, cfg.workers);
  }
  switch (cfg.policy) {
    case "strongest":
      return router.rank().slice(0, cfg.workers);
    case "fastest":
      return router.rank({}).sort((a, b) => (b.breakdown.latency ?? 0) - (a.breakdown.latency ?? 0)).slice(0, cfg.workers);
    case "diverse":
    default:
      return router.diverse(cfg.workers);
  }
}

function splitSpec(spec: string): [string, string | undefined] {
  const i = spec.indexOf("/");
  return i === -1 ? [spec, undefined] : [spec.slice(0, i), spec.slice(i + 1)];
}

/** Bounded-parallelism runner. */
async function withParallelism<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const DEFAULT_AGG_SYSTEM =
  "You are an aggregator. You have been given several candidate responses from " +
  "different models to the same user query. Synthesize a single, higher-quality " +
  "final answer. Reconcile disagreements, keep correct details, drop errors. " +
  "Respond only with the final answer.";

export class MoaOrchestrator {
  constructor(private cfg: MoaConfig, private router: Router, private executor: FailoverExecutor) {}

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Run the MoA pipeline for `req`. Returns the synthesized answer plus stats.
   * Throws only if zero workers succeed (caller should fall back to normal routing).
   */
  async run(req: ChatRequest): Promise<MoaResult> {
    const workers = pickWorkers(this.cfg, this.router);
    if (workers.length === 0) throw new Error("moa: no worker candidates available");

    // Fan out workers in parallel, each pinned to its candidate but still using
    // the executor (so a pinned worker that fails is simply a failed proposal).
    const proposals = await withParallelism(workers, this.cfg.parallelism, async (cand) => {
      const outcome = await this.executor.execute(req, { pinned: cand, timeoutMs: this.cfg.timeoutMs, maxAttempts: 1 });
      return outcome.result ? { model: `${cand.endpointId}/${cand.modelId}`, content: outcome.result.content } : null;
    });

    // Drop degenerate / prompt-parroting worker outputs (mislabeled public
    // endpoints echo the prompt or emit junk like "-232"), then require a quorum.
    const userText = req.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const good = proposals
      .filter((p): p is { model: string; content: string } => p !== null)
      .filter((p) => !isDegenerate(p.content) && !echoesPrompt(p.content, userText));
    if (good.length < Math.max(1, this.cfg.minWorkers)) {
      throw new Error(`moa: ${good.length}/${workers.length} usable worker answers (min ${this.cfg.minWorkers})`);
    }

    // Aggregate.
    const aggPrompt: ChatRequest = {
      messages: [
        { role: "system", content: DEFAULT_AGG_SYSTEM },
        { role: "user", content: buildAggregatorUserMessage(req, good) },
      ],
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      signal: req.signal,
    };

    const aggCand = this.resolveAggregator();
    const aggOutcome = await this.executor.execute(aggPrompt, {
      pinned: aggCand ?? undefined,
      query: aggCand ? undefined : {},
      timeoutMs: this.cfg.timeoutMs,
    });

    // Accept the aggregator only if it produced a real answer — not empty, not
    // our scaffolding echoed back, not junk. Otherwise use the best worker.
    if (aggOutcome.result && !isDegenerate(aggOutcome.result.content) && !echoesScaffolding(aggOutcome.result.content) && !echoesPrompt(aggOutcome.result.content, userText)) {
      return {
        content: aggOutcome.result.content,
        aggregatorEndpoint: aggOutcome.result.endpointId,
        workerCount: workers.length,
        succeededWorkers: good.length,
        usedFallback: false,
        workerModels: good.map((g) => g.model),
      };
    }

    // Aggregator failed or returned garbage -> best coherent worker proposal.
    return {
      content: good[0]!.content,
      aggregatorEndpoint: null,
      workerCount: workers.length,
      succeededWorkers: good.length,
      usedFallback: true,
      workerModels: good.map((g) => g.model),
    };
  }

  private resolveAggregator(): Candidate | null {
    if (this.cfg.aggregatorModel) {
      const [epId, modelId] = splitSpec(this.cfg.aggregatorModel);
      const ranked = this.router.rank();
      return ranked.find((c) => c.endpointId === epId && (!modelId || c.modelId === modelId))
        ?? ranked.find((c) => c.modelId === (modelId ?? this.cfg.aggregatorModel))
        ?? null;
    }
    // Auto: strongest healthy candidate overall (may equal a worker; that's fine).
    return this.router.best();
  }
}

/** True if the aggregator echoed our aggregation scaffolding instead of answering. */
export function echoesScaffolding(text: string): boolean {
  return /###\s*Candidate\s+\d|Produce the single best final answer|Original user query:|Candidate responses:/i.test(text);
}

/**
 * True if an answer just parrots the user's prompt back (honeypot/echo proxies
 * repeat the prompt, often several times) rather than answering it.
 */
export function echoesPrompt(answer: string, userText: string): boolean {
  const u = (userText ?? "").trim().toLowerCase();
  const a = (answer ?? "").toLowerCase();
  if (u.length < 20) return false;
  const key = u.slice(0, 40);
  // Prompt fragment repeated -> parrot.
  let idx = a.indexOf(key), count = 0;
  while (idx !== -1) { count++; idx = a.indexOf(key, idx + key.length); }
  if (count >= 2) return true;
  // Answer is largely just the prompt verbatim.
  return a.includes(u) && u.length > a.length * 0.5;
}

/**
 * True if a model's answer is unusable: empty, or "text" with no real words
 * (e.g. a stray number like "-232", punctuation, or a lone token). Answers with
 * at least a couple of alphabetic characters are kept.
 */
export function isDegenerate(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length === 0) return true;
  const letters = (t.match(/[A-Za-zÀ-ɏЀ-ӿ一-鿿]/g) ?? []).length;
  // Short and essentially non-lexical (numbers/symbols only) -> junk.
  if (t.length <= 8 && letters < 2) return true;
  return false;
}

function buildAggregatorUserMessage(req: ChatRequest, proposals: Array<{ model: string; content: string }>): string {
  const original = req.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const blocks = proposals.map((p, i) => `### Candidate ${i + 1} (${p.model})\n${p.content}`).join("\n\n");
  return `Original user query:\n${original}\n\nCandidate responses:\n${blocks}\n\nProduce the single best final answer.`;
}
