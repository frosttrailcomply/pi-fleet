// Endpoint probing: a TS port of legacy/ollama_recon.py's two phases.
//
//  Phase 1  /api/tags            -> enumerate installed model tags per host.
//  Phase 2  /v1/chat/completions -> a real "hello" call that must return
//                                   non-empty content for the model to count.
//
// All I/O is bounded by a concurrency limit. Timeouts use AbortController.

import type { ModelInfo } from "../types.ts";
import type { HostPort } from "./censys.ts";

const DEFAULT_CTX = 8192;

/** Best-effort parse of parameter size (billions) from an Ollama tag. */
export function parseSizeB(tag: string): number {
  // Matches 70b, 8x7b (mixtral -> ~47b active but treat as 56), 1.5b, 3B, etc.
  const moe = tag.match(/(\d+)x(\d+(?:\.\d+)?)b/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const m = tag.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/i);
  if (m) return Number(m[1]);
  return 0;
}

/** Rough context-window guess from known family hints; conservative default. */
export function guessContext(tag: string): number {
  const t = tag.toLowerCase();
  if (/llama3|llama-3|3\.1|3\.2|3\.3/.test(t)) return 131072;
  if (/qwen2\.5|qwen3/.test(t)) return 32768;
  if (/mistral|mixtral/.test(t)) return 32768;
  if (/gemma2|gemma3/.test(t)) return 8192;
  if (/phi3|phi-3|phi4/.test(t)) return 16384;
  if (/deepseek/.test(t)) return 65536;
  return DEFAULT_CTX;
}

async function withTimeout<T>(ms: number, signal: AbortSignal | undefined, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Phase 1: enumerate model tags via /api/tags. Returns null on failure. */
export async function fetchTags(baseUrl: string, opts: ProbeOptions = {}): Promise<string[] | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    return await withTimeout(opts.timeoutMs ?? 15_000, opts.signal, async (sig) => {
      const res = await doFetch(`${baseUrl}/api/tags`, { signal: sig });
      if (!res.ok) return null;
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
    });
  } catch {
    return null;
  }
}

export interface VerifyResult {
  ok: boolean;
  latencyMs: number;
  tokens: number;
  detail: string;
}

/** Phase 2: a real chat completion. Model must return non-empty content. */
export async function verifyModel(
  baseUrl: string,
  model: string,
  opts: ProbeOptions & { apiKey?: string } = {},
): Promise<VerifyResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  try {
    return await withTimeout(opts.timeoutMs ?? 15_000, opts.signal, async (sig) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 1, stream: false }),
        signal: sig,
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { ok: false, latencyMs, tokens: 0, detail: `chat_http_${res.status}` };
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return { ok: true, latencyMs, tokens: data.usage?.completion_tokens ?? 1, detail: "chat_ok" };
      }
      return { ok: false, latencyMs, tokens: 0, detail: "chat_empty_content" };
    });
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, tokens: 0, detail: `chat_error:${(e as Error).name}` };
  }
}

/** Simple bounded-concurrency map. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface DiscoveredEndpoint {
  host: string;
  port: number;
  baseUrl: string;
  models: ModelInfo[];
}

/**
 * Full recon over candidate host:port pairs: enumerate then verify. Returns
 * only endpoints that expose at least one verified model. `verifyOne` limits
 * verification to the first model per host by default (fast liveness), or all.
 */
export async function reconFleet(
  hosts: HostPort[],
  opts: ProbeOptions & { concurrency?: number; verifyAll?: boolean } = {},
): Promise<DiscoveredEndpoint[]> {
  const concurrency = opts.concurrency ?? 100;
  const results = await pool(hosts, concurrency, async (hp) => {
    const baseUrl = `http://${hp.host}:${hp.port}`;
    const tags = await fetchTags(baseUrl, opts);
    if (!tags || tags.length === 0) return null;
    const toVerify = opts.verifyAll ? tags : tags.slice(0, 1);
    const verified: ModelInfo[] = [];
    for (const tag of toVerify) {
      const v = await verifyModel(baseUrl, tag, opts);
      if (v.ok) verified.push({ id: tag, sizeB: parseSizeB(tag), contextWindow: guessContext(tag), verified: true });
    }
    // When only liveness-checking the first model, still list the rest as unverified.
    if (!opts.verifyAll) {
      for (const tag of tags.slice(1)) {
        verified.push({ id: tag, sizeB: parseSizeB(tag), contextWindow: guessContext(tag), verified: false });
      }
    }
    if (verified.length === 0) return null;
    return { host: hp.host, port: hp.port, baseUrl, models: verified } satisfies DiscoveredEndpoint;
  });
  return results.filter((r): r is DiscoveredEndpoint => r !== null);
}
