import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOllamaOptions {
  /** Model tags to advertise on /api/tags. */
  models?: string[];
  /** Artificial latency (ms) added to every response. */
  latencyMs?: number;
  /** If set, /v1/chat/completions returns this HTTP status instead of 200. */
  chatStatus?: number;
  /** If true, /api/tags fails (simulates an unreachable/broken host). */
  tagsFail?: boolean;
  /** Reply text for chat completions. */
  reply?: string;
  /** Fixed number of completion tokens to report (for throughput tests). */
  completionTokens?: number;
}

/**
 * A controllable in-process stand-in for an Ollama server exposing both the
 * native `/api/tags` endpoint and the OpenAI-compatible `/v1/chat/completions`
 * and `/v1/models` endpoints. Used across the test suite as a disposable,
 * authorized endpoint so no real external hosts are ever contacted.
 */
export class FakeOllama {
  private server: Server;
  private opts: Required<FakeOllamaOptions>;
  port = 0;

  constructor(opts: FakeOllamaOptions = {}) {
    this.opts = {
      models: opts.models ?? ["llama3.1:8b"],
      latencyMs: opts.latencyMs ?? 0,
      chatStatus: opts.chatStatus ?? 200,
      tagsFail: opts.tagsFail ?? false,
      reply: opts.reply ?? "ok",
      completionTokens: opts.completionTokens ?? 5,
    };
    this.server = createServer((req, res) => this.handle(req, res));
  }

  /** Mutate behavior at runtime (drives health-transition tests). */
  set(opts: Partial<FakeOllamaOptions>): void {
    Object.assign(this.opts, opts);
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    if (this.opts.latencyMs > 0) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const url = req.url ?? "/";

    if (url.startsWith("/api/tags")) {
      if (this.opts.tagsFail) {
        res.writeHead(503).end("unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: this.opts.models.map((name) => ({ name, model: name })) }));
      return;
    }

    if (url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: this.opts.models.map((id) => ({ id, object: "model" })) }));
      return;
    }

    if (url.startsWith("/v1/chat/completions")) {
      if (this.opts.chatStatus !== 200) {
        res.writeHead(this.opts.chatStatus).end(JSON.stringify({ error: "forced" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: this.opts.reply } }],
          usage: { prompt_tokens: 3, completion_tokens: this.opts.completionTokens, total_tokens: 3 + this.opts.completionTokens },
        }),
      );
      return;
    }

    res.writeHead(404).end("not found");
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }
}
