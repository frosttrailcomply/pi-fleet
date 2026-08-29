// pi extension entry point. Thin wiring: it constructs a FleetOrchestrator and
// exposes it to pi as the `fleet` provider plus a handful of commands and
// lifecycle hooks. All substantive logic lives in the (pi-independent, tested)
// engine; this file only translates between pi's API and the orchestrator.

import type { PiExtensionAPI, PiEventCtx, PiCommandCtx } from "./pi-types.ts";
import { loadConfig } from "../engine/config.ts";
import { FleetOrchestrator } from "../engine/orchestrator.ts";
import { newOutput, emitText, emitError, type PushableStream } from "./stream.ts";
import type { ChatMessage, ChatRequest } from "../engine/types.ts";

const PROVIDER = "fleet";

/** Best-effort extraction of chat messages from pi's stream context. */
function extractMessages(context: unknown): ChatMessage[] {
  const ctx = context as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
  const raw = ctx?.messages ?? [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m.role === "system" || m.role === "assistant" || m.role === "tool") ? m.role : "user";
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      content = m.content.map((b) => (typeof b === "string" ? b : (b as { text?: string })?.text ?? "")).join("");
    }
    out.push({ role, content });
  }
  return out;
}

function modelIdOf(model: unknown): string {
  const m = model as { id?: string } | string | undefined;
  return typeof m === "string" ? m : m?.id ?? "auto";
}

export default async function fleetExtension(pi: PiExtensionAPI): Promise<void> {
  const configPath = process.env.PI_FLEET_CONFIG;
  const cfg = loadConfig(configPath);
  const orch = new FleetOrchestrator(cfg);
  orch.init();

  const modelDefs = () =>
    orch.listModels().map((m) => ({
      id: m.id, name: m.name, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow, maxTokens: 4096,
    }));

  // --- Register the virtual `fleet` provider ---------------------------------
  pi.registerProvider(PROVIDER, {
    name: "Fleet",
    api: "openai-completions",
    models: modelDefs(),
    // Refresh advertised models as discovery changes the fleet.
    refreshModels: async () => modelDefs(),
    // Resolve the whole answer via routing/MoA, then re-emit as a pi stream.
    streamSimple: (model: unknown, context: unknown, options?: unknown) => {
      const stream = makeStream();
      const modelId = modelIdOf(model);
      const signal = (options as { signal?: AbortSignal })?.signal;
      const messages = extractMessages(context);
      const req: ChatRequest = { messages, signal };
      void (async () => {
        const output = newOutput(PROVIDER, modelId);
        try {
          if (modelId === "moa" && cfg.moa.enabled) {
            try {
              const r = await orch.moaChat(req);
              emitText(stream, output, r.content, Math.ceil(r.content.length / 4));
              return;
            } catch {
              /* too few workers — fall through to auto route */
            }
          }
          if (modelId !== "auto" && modelId !== "moa" && modelId.includes("/")) {
            // Pinned discovered model "endpointId/modelId".
            const [epId, mId] = splitOnce(modelId, "/");
            const conn = orch.connFor(epId);
            if (conn) {
              const out = await orch.executor.execute(req, { query: { endpointIds: [epId], modelFilter: (m) => m.id === mId }, timeoutMs: cfg.health.requestTimeoutMs });
              if (out.result) { emitText(stream, output, out.result.content, out.result.tokens); return; }
            }
          }
          const out = await orch.chat(req);
          if (out.result) emitText(stream, output, out.result.content, out.result.tokens);
          else emitError(stream, output, `fleet: all ${out.attempts.length} candidates failed`);
        } catch (e) {
          emitError(stream, output, (e as Error).message, signal?.aborted);
        }
      })();
      return stream.piStream;
    },
  });

  // --- Commands --------------------------------------------------------------
  pi.registerCommand("fleet", {
    description: "Show fleet status (endpoints, health, models, memory)",
    handler: (_args: string, ctx: PiCommandCtx) => {
      const s = orch.status();
      const lines = [
        `Fleet: ${s.endpoints.length} endpoints, ${s.totalModels} verified models`,
        `MoA: ${s.moaEnabled ? "on" : "off"} | Memory: ${s.memoryLessons} lessons | Evolution: ${s.evolutionEnabled ? "on" : "off"}`,
        ...s.endpoints.map((e) => `  ${e.health.padEnd(9)} ${e.breaker.padEnd(9)} ${String(e.models).padStart(3)}m ${String(e.latencyMs).padStart(5)}ms rel=${e.reliability} [${e.source}] ${e.id}`),
      ];
      report(ctx, lines.join("\n"));
    },
  });

  pi.registerCommand("fleet-refresh", {
    description: "Force an immediate fleet discovery + health refresh",
    handler: async (_args: string, ctx: PiCommandCtx) => {
      const n = await orch.refresher.runFullRefresh();
      await orch.refresher.runHealthProbe();
      report(ctx, `Fleet refreshed: ${n} endpoints discovered/updated; ${orch.status().totalModels} models live.`);
    },
  });

  pi.registerCommand("fleet-moa", {
    description: "Toggle Mixture of Agents: /fleet-moa on|off",
    handler: (args: string, ctx: PiCommandCtx) => {
      const v = args.trim().toLowerCase();
      if (v === "on" || v === "off") cfg.moa.enabled = v === "on";
      report(ctx, `MoA ${cfg.moa.enabled ? "enabled" : "disabled"} (${cfg.moa.workers} workers, policy=${cfg.moa.policy}).`);
    },
  });

  pi.registerCommand("fleet-evolve", {
    description: "Run one self-evolution cycle now (bounded, reversible)",
    handler: (_args: string, ctx: PiCommandCtx) => {
      const outcomes = orch.runEvolution();
      if (outcomes.length === 0) { report(ctx, "Evolution: disabled or no measurable weaknesses."); return; }
      report(ctx, outcomes.map((o) => `${o.accepted ? "ACCEPTED" : "kept-as-is"}: ${o.proposal.description}`).join("\n"));
    },
  });

  pi.registerCommand("fleet-remember", {
    description: "Store an environment fact/lesson: /fleet-remember <text>",
    handler: (args: string, ctx: PiCommandCtx) => {
      const text = args.trim();
      if (!text) { report(ctx, "usage: /fleet-remember <text>"); return; }
      orch.improvement?.note("env-fact", text, ["manual"]);
      report(ctx, "Remembered.");
    },
  });

  pi.registerFlag?.("fleet-config", { description: "Path to a fleet.config.json", type: "string" });

  // --- Lifecycle hooks -------------------------------------------------------
  pi.on("session_start", async (_e: unknown, _ctx: PiEventCtx) => {
    await orch.start().catch(() => {});
  });

  pi.on("session_shutdown", () => {
    orch.stop();
  });

  // Feed tool outcomes into self-improvement.
  pi.on("tool_result", (event: unknown) => {
    const e = event as { toolName?: string; isError?: boolean; content?: unknown; cwd?: string };
    const ok = !e.isError;
    const text = typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? "");
    orch.observeTool({ tool: e.toolName ?? "unknown", ok, errorSignature: ok ? undefined : firstLine(text), detail: undefined, cwd: e.cwd });
  });

  // Inject relevant lessons before each agent turn.
  pi.on("before_agent_start", (event: unknown) => {
    const e = event as { prompt?: string; systemPrompt?: string };
    const lessons = orch.retrieveLessons(e.prompt ?? "");
    if (lessons.length && pi.sendMessage) {
      const block = lessons.map((l) => `- [${l.kind}] ${l.text}`).join("\n");
      pi.sendMessage({ role: "user", content: `pi-fleet recalled lessons:\n${block}` }, { deliverAs: "nextTurn", triggerTurn: false });
    }
  });
}

// --- helpers -----------------------------------------------------------------

interface StreamHandle { piStream: unknown; push: PushableStream["push"]; end: PushableStream["end"]; }

/** A tiny event buffer that also satisfies async-iteration if pi consumes it that way. */
function makeStream(): StreamHandle & PushableStream {
  const events: Record<string, unknown>[] = [];
  let done = false;
  let notify: (() => void) | null = null;
  const push = (ev: Record<string, unknown>) => { events.push(ev); notify?.(); };
  const end = () => { done = true; notify?.(); };
  const iterator = async function* () {
    let i = 0;
    while (!done || i < events.length) {
      if (i < events.length) { yield events[i++]; continue; }
      await new Promise<void>((r) => (notify = r));
      notify = null;
    }
  };
  const piStream = { push, end, [Symbol.asyncIterator]: iterator, events };
  return { piStream, push, end };
}

function report(ctx: PiCommandCtx, msg: string): void {
  if (ctx.ui?.notify) ctx.ui.notify(msg);
  else console.log(msg);
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? s).slice(0, 200);
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
