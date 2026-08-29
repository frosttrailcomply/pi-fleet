// pi extension entry point. Thin wiring: it constructs a FleetOrchestrator and
// exposes it to pi as the `fleet` provider plus a handful of commands and
// lifecycle hooks. All substantive logic lives in the (pi-independent, tested)
// engine; this file only translates between pi's API and the orchestrator.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiExtensionAPI, PiEventCtx, PiCommandCtx } from "./pi-types.ts";
import { loadConfig } from "../engine/config.ts";
import { FleetOrchestrator } from "../engine/orchestrator.ts";
import { FleetGateway } from "./gateway.ts";

const PROVIDER = "fleet";
// Package root (…/src/ext → …). Lets the default browser-scrape command resolve
// ${PI_FLEET_DIR}/scripts/censys-camofox.mjs.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default async function fleetExtension(pi: PiExtensionAPI): Promise<void> {
  if (!process.env.PI_FLEET_DIR) process.env.PI_FLEET_DIR = PKG_ROOT;
  const configPath = process.env.PI_FLEET_CONFIG;
  const cfg = loadConfig(configPath);
  // pi surfaces a provider's models only when its apiKey resolves via an env var
  // (or auth.json). The fleet gateway needs no upstream credential, so we point
  // at PI_FLEET_KEY and default it; the value is never sent anywhere real.
  if (!process.env.PI_FLEET_KEY) process.env.PI_FLEET_KEY = "fleet-local";

  const orch = new FleetOrchestrator(cfg);
  orch.init();
  const gateway = new FleetGateway(orch);
  // Bind the gateway during the (awaited) factory so it is reachable before pi
  // probes the provider's baseUrl for readiness — starting it later, in
  // session_start, deadlocks that readiness check. Closed in session_shutdown.
  let gatewayUp = false;
  try {
    await gateway.start(cfg.gatewayPort);
    gatewayUp = true;
  } catch (e) {
    console.error(`[pi-fleet] gateway failed to bind port ${cfg.gatewayPort}: ${(e as Error).message}`);
  }

  const modelDefs = () =>
    orch.listModels().map((m) => ({
      id: m.id, name: m.name, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow, maxTokens: 4096,
    }));

  // --- Register the `fleet` provider -----------------------------------------
  // pi talks to the local FleetGateway as an ordinary OpenAI-compatible provider;
  // the gateway does all routing/failover/MoA internally. This keeps the
  // integration on pi's well-supported provider path (no internal stream API).
  pi.registerProvider(PROVIDER, {
    name: "Fleet",
    baseUrl: `http://127.0.0.1:${cfg.gatewayPort}/v1`,
    api: "openai-completions",
    apiKey: "$PI_FLEET_KEY",
    models: modelDefs(),
    // Refresh advertised models as discovery changes the fleet.
    refreshModels: async () => modelDefs(),
  });

  // --- Commands --------------------------------------------------------------
  pi.registerCommand("fleet", {
    description: "Show fleet status (endpoints, health, models, memory)",
    handler: (_args: string, ctx: PiCommandCtx) => {
      const s = orch.status();
      const lines = [
        `Fleet: ${s.endpoints.length} endpoints, ${s.totalModels} verified models`,
        `MoA: ${s.moaEnabled ? "on" : "off"} | Memory: ${s.memoryBackend} (${s.memoryLessons} lessons) | Evolution: ${s.evolutionEnabled ? "on" : "off"}`,
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
      orch.note("env-fact", text, ["manual"]);
      report(ctx, "Remembered.");
    },
  });

  pi.registerFlag?.("fleet-config", { description: "Path to a fleet.config.json", type: "string" });

  // --- Lifecycle hooks -------------------------------------------------------
  pi.on("session_start", async (_e: unknown, _ctx: PiEventCtx) => {
    await orch.start().catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    if (gatewayUp) await gateway.stop().catch(() => {});
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
  pi.on("before_agent_start", async (event: unknown) => {
    const e = event as { prompt?: string; systemPrompt?: string };
    const lessons = await orch.retrieveLessons(e.prompt ?? "");
    if (lessons.length && pi.sendMessage) {
      const block = lessons.map((l) => `- [${l.kind}] ${l.text}`).join("\n");
      pi.sendMessage({ role: "user", content: `pi-fleet recalled lessons:\n${block}` }, { deliverAs: "nextTurn", triggerTurn: false });
    }
  });
}

// --- helpers -----------------------------------------------------------------

function report(ctx: PiCommandCtx, msg: string): void {
  if (ctx.ui?.notify) ctx.ui.notify(msg);
  else console.log(msg);
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? s).slice(0, 200);
}
