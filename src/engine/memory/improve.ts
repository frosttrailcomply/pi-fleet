// Self-improvement observer.
//
// Watches structured session signals (tool outcomes, recurring errors,
// successful recovery after failure) and distills durable lessons into the
// MemoryStore. Engine-pure: it consumes plain event objects so it can be unit
// tested without pi; the extension adapter feeds it from tool_result/agent_end
// hooks and calls retrieveForPrompt() at before_agent_start.

import type { MemoryStore, ScoredLesson } from "./store.ts";

export interface ToolOutcome {
  tool: string;
  ok: boolean;
  /** Short error signature (first decisive line), if failed. */
  errorSignature?: string;
  /** Optional command / args summary for context. */
  detail?: string;
  cwd?: string;
}

/** Normalize a raw error string to a stable signature (drops volatile bits). */
export function errorSignature(raw: string): string {
  return raw
    .replace(/0x[0-9a-f]+/gi, "0x?")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "IP") // IPv4 -> IP (before generic digits)
    .replace(/:\d{2,5}\b/g, ":PORT") // :port
    .replace(/\b\d{2,}\b/g, "N")
    .replace(/(['"]).*?\1/g, "$1?$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export class SelfImprovement {
  /** Track consecutive failures per (tool+signature) to detect recurring pitfalls. */
  private failureStreak = new Map<string, number>();
  /** Track that a tool+signature was failing, to later capture the workaround. */
  private pending = new Map<string, ToolOutcome>();

  constructor(private store: MemoryStore, private minRepeats = 2) {}

  private key(o: ToolOutcome): string {
    return `${o.tool}::${o.errorSignature ?? ""}`;
  }

  /**
   * Observe one tool outcome. Emits a "pitfall" lesson once a failure recurs,
   * and a "workaround" lesson when a previously-failing tool/signature succeeds.
   */
  observeTool(o: ToolOutcome): void {
    const k = this.key(o);
    if (!o.ok && o.errorSignature) {
      const streak = (this.failureStreak.get(k) ?? 0) + 1;
      this.failureStreak.set(k, streak);
      this.pending.set(o.tool, o);
      if (streak >= this.minRepeats) {
        this.store.remember({
          kind: "pitfall",
          text: `Tool "${o.tool}" repeatedly failed: ${o.errorSignature}${o.detail ? ` (${o.detail})` : ""}`,
          tags: [o.tool, "pitfall", ...(o.cwd ? ["cwd:" + o.cwd] : [])],
          context: `${o.tool}|${o.errorSignature}`,
          weight: 1 + streak * 0.5,
        });
      }
    } else if (o.ok) {
      // A success after a recorded failure streak for the same tool is a workaround.
      const priorFail = this.pending.get(o.tool);
      if (priorFail && (this.failureStreak.get(this.key(priorFail)) ?? 0) >= this.minRepeats) {
        this.store.remember({
          kind: "workaround",
          text: `Recovered "${o.tool}" after failing with "${priorFail.errorSignature}"${o.detail ? `: ${o.detail}` : ""}`,
          tags: [o.tool, "workaround"],
          context: `${o.tool}|${priorFail.errorSignature}`,
          weight: 2,
        });
      }
      this.failureStreak.delete(this.key({ tool: o.tool, ok: false, errorSignature: priorFail?.errorSignature }));
      this.pending.delete(o.tool);
    }
  }

  /** Record an explicit environment fact or lesson (e.g. from user or agent). */
  note(kind: "lesson" | "env-fact", text: string, tags: string[] = [], context = ""): void {
    this.store.remember({ kind, text, tags, context, weight: 1.5 });
  }

  /** Retrieve relevant lessons to inject before an agent turn. */
  retrieveForPrompt(prompt: string, tags: string[] = [], topK = 5, minScore = 0.15): ScoredLesson[] {
    return this.store.retrieve({ text: prompt, tags, topK, minScore });
  }

  /** Render retrieved lessons as a compact context block for the system prompt. */
  static renderLessons(lessons: ScoredLesson[]): string {
    if (lessons.length === 0) return "";
    const lines = lessons.map((l) => `- [${l.kind}] ${l.text}`);
    return `Relevant lessons from past sessions (pi-fleet memory):\n${lines.join("\n")}`;
  }
}
