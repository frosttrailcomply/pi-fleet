// FleetGateway: a small OpenAI-compatible HTTP server that pi (and any other
// OpenAI client) talks to as an ordinary provider. Internally it routes each
// request through the FleetOrchestrator — capability/health-weighted routing,
// transparent failover, and MoA — so all the fleet's value is delivered over a
// standard `/v1/chat/completions` surface with no coupling to pi's internal
// streaming API.
//
// Model field semantics:
//   auto                 -> best endpoint with failover
//   moa                  -> Mixture of Agents (falls back to auto on too-few workers)
//   <endpointId>/<model> -> pinned to a specific discovered/configured model
//
// Supports both non-streaming JSON and SSE (stream:true) responses.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FleetOrchestrator } from "../engine/orchestrator.ts";
import type { ChatMessage, ChatRequest } from "../engine/types.ts";

export class FleetGateway {
  private server: Server;
  port = 0;

  constructor(private orch: FleetOrchestrator) {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => this.fail(res, 500, String(e))));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
  }

  private fail(res: ServerResponse, code: number, message: string): void {
    if (!res.headersSent) res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (url.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: this.orch.listModels().map((m) => ({ id: m.id, object: "model", owned_by: "fleet" })) }));
      return;
    }
    if (url.startsWith("/health")) { res.writeHead(200).end("ok"); return; }
    if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) { this.fail(res, 404, "not found"); return; }

    const body = (await this.readBody(req)) as { model?: string; messages?: Array<{ role?: string; content?: unknown }>; stream?: boolean; max_tokens?: number; temperature?: number };
    const model = body.model ?? "auto";
    const messages: ChatMessage[] = (body.messages ?? []).map((m) => ({
      role: (m.role === "system" || m.role === "assistant" || m.role === "tool") ? m.role : "user",
      content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? "")).join("") : "",
    }));
    const chatReq: ChatRequest = { messages, maxTokens: body.max_tokens, temperature: body.temperature };

    const answer = await this.route(model, chatReq);
    if (answer === null) { this.fail(res, 502, "fleet: no endpoint answered"); return; }

    if (body.stream) this.sse(res, model, answer);
    else this.json(res, model, answer);
  }

  /** Resolve the answer text according to the model field. Returns null on total failure. */
  private async route(model: string, req: ChatRequest): Promise<string | null> {
    if (model === "moa" && this.orch.cfg.moa.enabled) {
      try { return (await this.orch.moaChat(req)).content; } catch { /* fall through to auto */ }
    }
    if (model !== "auto" && model !== "moa" && model.includes("/")) {
      const i = model.indexOf("/");
      const epId = model.slice(0, i), mId = model.slice(i + 1);
      const out = await this.orch.executor.execute(req, { query: { endpointIds: [epId], modelFilter: (m) => m.id === mId }, timeoutMs: this.orch.cfg.health.requestTimeoutMs });
      if (out.result) return out.result.content;
    }
    const out = await this.orch.chat(req);
    return out.result ? out.result.content : null;
  }

  private json(res: ServerResponse, model: string, content: string): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `fleet-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: Math.ceil(content.length / 4), total_tokens: Math.ceil(content.length / 4) },
    }));
  }

  private sse(res: ServerResponse, model: string, content: string): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = `fleet-${Date.now()}`, created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant" }, null));
    res.write(chunk({ content }, null));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  }

  /** Bind to `port` (0 = ephemeral). Returns the bound port. */
  async start(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => { this.server.removeAllListeners("error"); resolve(); });
    });
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
