// A single OpenAI-compatible chat completion call with timeout + latency
// measurement. Shared by the executor and MoA. Non-streaming (the fleet
// provider adapter re-emits the full text as a stream to pi).

import type { ChatRequest } from "../types.ts";

export interface ChatCallResult {
  ok: boolean;
  content: string;
  latencyMs: number;
  tokens: number;
  detail: string;
}

export interface ChatCallOptions {
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function verifyModelChat(
  baseUrl: string,
  model: string,
  req: ChatRequest,
  opts: ChatCallOptions = {},
): Promise<ChatCallResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  const started = Date.now();
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: false,
      }),
      signal: ac.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, content: "", latencyMs, tokens: 0, detail: `http_${res.status}` };
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (typeof content === "string" && content.trim()) {
      return { ok: true, content, latencyMs, tokens: data.usage?.completion_tokens ?? Math.ceil(content.length / 4), detail: "ok" };
    }
    return { ok: false, content: "", latencyMs, tokens: 0, detail: "empty_content" };
  } catch (e) {
    return { ok: false, content: "", latencyMs: Date.now() - started, tokens: 0, detail: `error:${(e as Error).name}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
