// Self-evolution: bounded, reversible, test-gated self-tuning.
//
// The loop is literal and safe:
//   observe   -> measurable weaknesses from live registry stats + memory
//   propose   -> the minimal change that could fix one weakness
//   apply     -> mutate live state, remembering an exact undo
//   evaluate  -> score before vs after with an injected evaluator
//   decide    -> keep the change only if it measurably improved; else roll back
//   record    -> write a lesson either way so the same probe isn't repeated
//
// Autonomous auto-apply is intentionally limited to *reversible configuration*
// (routing weights, endpoint quarantine, health thresholds). Anything touching
// code or skills is emitted as a git-tracked proposal artifact for human review
// rather than applied automatically. Config snapshots are persisted (and, when
// a git runner is provided, committed) so every accepted change is revertible.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FleetConfig, EvolutionConfig } from "../types.ts";
import type { FleetRegistry } from "../registry.ts";
import type { Router } from "../routing/router.ts";
import type { MemoryStore } from "./store.ts";

export interface Weakness {
  kind: "flaky-endpoint" | "high-latency" | "recurring-pitfall";
  target: string;
  observations: number;
  detail: string;
}

export interface Proposal {
  id: string;
  weakness: Weakness;
  /** Human-readable description of the change. */
  description: string;
  /** True if this change can be auto-applied (reversible config only). */
  autoApplicable: boolean;
  /** Apply the change; returns an undo function. */
  apply: () => () => void;
}

export interface CycleOutcome {
  proposal: Proposal;
  before: number;
  after: number;
  accepted: boolean;
  reason: string;
}

export type Evaluator = () => number;

/** Injectable git runner so tests stay hermetic. */
export type GitRunner = (args: string[], cwd: string) => void;

export class EvolutionEngine {
  private counter = 0;

  constructor(
    private cfg: EvolutionConfig,
    private fleet: FleetConfig,
    private registry: FleetRegistry,
    private router: Router,
    private memory: MemoryStore,
    private git?: GitRunner,
  ) {}

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  /** Identify measurable weaknesses that clear the minObservations bar. */
  analyze(): Weakness[] {
    const out: Weakness[] = [];
    for (const rec of this.registry.all()) {
      const { successes, failures, latencyMs } = rec.stats;
      const total = successes + failures;
      if (total >= this.cfg.minObservations) {
        const rate = successes / total;
        if (rate < 0.5) {
          out.push({ kind: "flaky-endpoint", target: rec.endpoint.id, observations: total, detail: `success rate ${(rate * 100).toFixed(0)}% over ${total} calls` });
        } else if (latencyMs > 3000) {
          out.push({ kind: "high-latency", target: rec.endpoint.id, observations: total, detail: `mean latency ${latencyMs.toFixed(0)}ms` });
        }
      }
    }
    // Recurring pitfalls from memory (high-weight pitfalls => worth a code proposal).
    for (const l of this.memory.all()) {
      if (l.kind === "pitfall" && l.weight >= 2 + this.cfg.minObservations * 0.5) {
        out.push({ kind: "recurring-pitfall", target: l.context, observations: Math.round(l.weight), detail: l.text });
      }
    }
    return out;
  }

  /** Turn a weakness into a minimal, mostly-reversible proposal. */
  propose(w: Weakness): Proposal {
    const id = `evo-${Date.now()}-${this.counter++}`;
    if (w.kind === "flaky-endpoint") {
      return {
        id, weakness: w, autoApplicable: true,
        description: `Quarantine flaky endpoint ${w.target} (${w.detail})`,
        apply: () => {
          const rec = this.registry.get(w.target);
          const snapshot = rec ? structuredClone(rec.endpoint) : null;
          this.registry.remove(w.target);
          return () => { if (snapshot) this.registry.upsert(snapshot); };
        },
      };
    }
    if (w.kind === "high-latency") {
      return {
        id, weakness: w, autoApplicable: true,
        description: `Increase latency routing weight to deprioritize slow endpoints (${w.detail})`,
        apply: () => {
          const prev = { ...this.fleet.routing };
          this.fleet.routing = { ...this.fleet.routing, latency: Math.min(5, this.fleet.routing.latency + 0.4) };
          this.router.setWeights(this.fleet.routing);
          return () => { this.fleet.routing = prev; this.router.setWeights(prev); };
        },
      };
    }
    // recurring-pitfall -> code/skill proposal artifact, NOT auto-applied.
    return {
      id, weakness: w, autoApplicable: false,
      description: `Proposed remediation for recurring pitfall: ${w.detail}`,
      apply: () => () => {}, // no-op; artifact-only
    };
  }

  /**
   * Run one full evolution cycle against an injected evaluator (higher = better).
   * Auto-applies only reversible config proposals; keeps a change solely if it
   * measurably improved the score, otherwise rolls back. Records a lesson and
   * persists an artifact either way.
   */
  runCycle(evaluate: Evaluator, epsilon = 1e-6): CycleOutcome[] {
    const outcomes: CycleOutcome[] = [];
    for (const w of this.analyze()) {
      const proposal = this.propose(w);

      if (!proposal.autoApplicable || !this.cfg.autoApply) {
        // Emit a git-tracked artifact for human review; do not touch live state.
        this.persistArtifact(proposal, { applied: false, reason: proposal.autoApplicable ? "autoApply disabled" : "requires human review" });
        this.memory.remember({ kind: "lesson", text: `Evolution proposal (manual): ${proposal.description}`, tags: ["evolution", "proposal"], context: proposal.id, weight: 1 });
        outcomes.push({ proposal, before: 0, after: 0, accepted: false, reason: "artifact-only (manual review)" });
        continue;
      }

      const before = evaluate();
      const undo = proposal.apply();
      const after = evaluate();
      const improved = after > before + epsilon;

      if (improved) {
        this.persistArtifact(proposal, { applied: true, before, after });
        this.memory.remember({ kind: "lesson", text: `Evolution ACCEPTED: ${proposal.description} (score ${before.toFixed(3)} -> ${after.toFixed(3)})`, tags: ["evolution", "accepted"], context: proposal.id, weight: 2 });
        this.commit(proposal, before, after);
        outcomes.push({ proposal, before, after, accepted: true, reason: "measured improvement" });
      } else {
        undo(); // roll back — never let evolution degrade the working system
        this.persistArtifact(proposal, { applied: false, before, after, reason: "no improvement, rolled back" });
        this.memory.remember({ kind: "lesson", text: `Evolution REJECTED: ${proposal.description} (score ${before.toFixed(3)} -> ${after.toFixed(3)}, rolled back)`, tags: ["evolution", "rejected"], context: proposal.id, weight: 1.5 });
        outcomes.push({ proposal, before, after, accepted: false, reason: "no improvement (rolled back)" });
      }
    }
    return outcomes;
  }

  private persistArtifact(proposal: Proposal, meta: Record<string, unknown>): void {
    try {
      mkdirSync(this.cfg.workDir, { recursive: true });
      const path = join(this.cfg.workDir, `${proposal.id}.json`);
      writeFileSync(path, JSON.stringify({ id: proposal.id, description: proposal.description, weakness: proposal.weakness, autoApplicable: proposal.autoApplicable, ...meta, at: new Date().toISOString() }, null, 2));
    } catch {
      // Persistence is best-effort; never fail a cycle over disk issues.
    }
  }

  private commit(proposal: Proposal, before: number, after: number): void {
    if (!this.git) return;
    try {
      this.git(["add", this.cfg.workDir], process.cwd());
      this.git(["commit", "-m", `evo: ${proposal.description} (${before.toFixed(3)}->${after.toFixed(3)})`], process.cwd());
    } catch {
      // Git may be unavailable or nothing staged; not fatal.
    }
  }
}
