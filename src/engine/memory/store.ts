// Local-first lesson store backed by node:sqlite (built-in, zero native deps).
//
// Chosen over external memory frameworks (mem0/Zep/Letta/...) deliberately:
// local-first, no network or API keys, portable, negligible token/latency
// overhead, and full control over retrieval. The retrieval need here —
// surfacing recurring pitfalls, environment facts, and verified workarounds
// keyed by tool name and error signature — is met well by lexical + tag +
// recency scoring, without standing up vector infrastructure.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Lesson } from "../types.ts";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was", "were",
  "it", "this", "that", "as", "at", "by", "be", "has", "have", "had", "not", "no", "you", "your", "i",
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Jaccard-ish overlap of two token sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

export interface RetrieveQuery {
  text: string;
  tags?: string[];
  topK?: number;
  minScore?: number;
}

export interface ScoredLesson extends Lesson {
  score: number;
}

export class MemoryStore {
  private db: DatabaseSync;

  constructor(dbPath: string, private now: () => number = Date.now) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        context TEXT NOT NULL DEFAULT '',
        weight REAL NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        lastUsed INTEGER NOT NULL DEFAULT 0,
        uses INTEGER NOT NULL DEFAULT 0,
        sig TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lessons_sig ON lessons(sig);
      CREATE INDEX IF NOT EXISTS idx_lessons_kind ON lessons(kind);
    `);
  }

  /** Stable signature for dedup: kind + normalized text + context. */
  private sig(kind: string, text: string, context: string): string {
    return `${kind}|${tokenize(text).sort().join(" ")}|${context}`.slice(0, 400);
  }

  /**
   * Insert a lesson, or reinforce an existing near-duplicate (same signature)
   * by bumping its weight and refreshing timestamps. Returns the row id.
   */
  remember(l: Omit<Lesson, "id" | "createdAt" | "lastUsed" | "uses"> & { createdAt?: number }): number {
    const sig = this.sig(l.kind, l.text, l.context);
    const existing = this.db.prepare("SELECT id, weight FROM lessons WHERE sig = ?").get(sig) as { id: number; weight: number } | undefined;
    const t = l.createdAt ?? this.now();
    if (existing) {
      this.db.prepare("UPDATE lessons SET weight = ?, lastUsed = ? WHERE id = ?").run(Math.min(10, existing.weight + 0.5), t, existing.id);
      return existing.id;
    }
    const res = this.db
      .prepare("INSERT INTO lessons (kind, text, tags, context, weight, createdAt, lastUsed, uses, sig) VALUES (?,?,?,?,?,?,?,0,?)")
      .run(l.kind, l.text, JSON.stringify(l.tags ?? []), l.context ?? "", l.weight ?? 1, t, 0, sig);
    return Number(res.lastInsertRowid);
  }

  private rowToLesson(row: Record<string, unknown>): Lesson {
    return {
      id: row.id as number,
      kind: row.kind as Lesson["kind"],
      text: row.text as string,
      tags: JSON.parse((row.tags as string) || "[]"),
      context: row.context as string,
      weight: row.weight as number,
      createdAt: row.createdAt as number,
      lastUsed: row.lastUsed as number,
      uses: row.uses as number,
    };
  }

  all(): Lesson[] {
    return (this.db.prepare("SELECT * FROM lessons ORDER BY createdAt DESC").all() as Record<string, unknown>[]).map((r) => this.rowToLesson(r));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM lessons").get() as { c: number }).c;
  }

  /** Retrieve the most relevant lessons for a query and mark them used. */
  retrieve(q: RetrieveQuery): ScoredLesson[] {
    const topK = q.topK ?? 5;
    const minScore = q.minScore ?? 0.15;
    const qTokens = new Set(tokenize(q.text));
    const qTags = new Set((q.tags ?? []).map((t) => t.toLowerCase()));
    const nowT = this.now();

    const scored: ScoredLesson[] = [];
    for (const row of this.db.prepare("SELECT * FROM lessons").all() as Record<string, unknown>[]) {
      const l = this.rowToLesson(row);
      const lTokens = new Set([...tokenize(l.text), ...tokenize(l.context)]);
      const lex = overlap(qTokens, lTokens);
      const tagHits = [...qTags].filter((t) => l.tags.map((x) => x.toLowerCase()).includes(t)).length;
      const tagScore = qTags.size ? tagHits / qTags.size : 0;
      // Recency: decays over ~14 days.
      const ageDays = (nowT - l.createdAt) / 86_400_000;
      const recency = Math.exp(-ageDays / 14);
      const weightBoost = Math.min(1, l.weight / 5);
      const score = lex * 0.6 + tagScore * 0.3 + recency * 0.1 + weightBoost * 0.1;
      if (score >= minScore) scored.push({ ...l, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);
    // Mark retrieved lessons used (reinforcement signal).
    const upd = this.db.prepare("UPDATE lessons SET uses = uses + 1, lastUsed = ? WHERE id = ?");
    for (const l of top) upd.run(nowT, l.id!);
    return top;
  }

  /** Prune low-value stale lessons (never-used, low weight, older than maxAgeDays). */
  prune(maxAgeDays = 90): number {
    const cutoff = this.now() - maxAgeDays * 86_400_000;
    const res = this.db.prepare("DELETE FROM lessons WHERE uses = 0 AND weight <= 1 AND createdAt < ?").run(cutoff);
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}
