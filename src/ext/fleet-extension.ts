// pi extension entry point. Thin wiring: it constructs a FleetOrchestrator and
// exposes it to pi as the `fleet` provider plus a handful of commands and
// lifecycle hooks. All substantive logic lives in the (pi-independent, tested)
// engine; this file only translates between pi's API and the orchestrator.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiExtensionAPI, PiEventCtx, PiCommandCtx } from "./pi-types.ts";
import { loadConfig } from "../engine/config.ts";
import { loadFleetEnv } from "../engine/env.ts";
import { FleetOrchestrator } from "../engine/orchestrator.ts";
import { FleetGateway } from "./gateway.ts";

const PROVIDER = "fleet";
// Package root (…/src/ext → …). Lets the default browser-scrape command resolve
// ${PI_FLEET_DIR}/scripts/censys-camofox.mjs.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Best-effort: ensure the Camofox container is up (fast start; no blocking). */
function ensureCamofox(): void {
  const child = spawn(process.execPath, [join(PKG_ROOT, "scripts", "setup-browser-search.mjs"), "--start-only"], {
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
}

export default async function fleetExtension(pi: PiExtensionAPI): Promise<void> {
  if (!process.env.PI_FLEET_DIR) process.env.PI_FLEET_DIR = PKG_ROOT;
  loadFleetEnv(); // pull CAMOFOX_API_KEY / BROWSER_SEARCH_DIR from ~/.pi/agent/fleet
  const configPath = process.env.PI_FLEET_CONFIG;
  const cfg = loadConfig(configPath);
  // Restore persisted MoA on/off state (survives restarts).
  const persistedMoa = loadMoaState(cfg.stateDir);
  if (persistedMoa !== null) cfg.moa.enabled = persistedMoa;
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
      // Immediate feedback, then live phase updates while the (network-bound)
      // discovery runs — otherwise the TUI shows nothing until it finishes.
      ctx.ui?.notify?.("Fleet: refreshing…", "info");
      status(ctx, "Fleet: discovering endpoints (scraping Censys)…");
      const n = await orch.refresher.runFullRefresh();
      status(ctx, `Fleet: probing health of ${orch.status().endpoints.length} endpoints…`);
      await orch.refresher.runHealthProbe();
      report(ctx, `Fleet refreshed: ${n} endpoints discovered/updated; ${orch.status().totalModels} models live.`);
    },
  });

  pi.registerCommand("fleet-moa", {
    description: "Toggle Mixture of Agents: /fleet-moa on|off",
    handler: async (args: string, ctx: PiCommandCtx) => {
      const v = args.trim().toLowerCase();
      if (v === "on" || v === "off") cfg.moa.enabled = v === "on";
      saveMoaState(cfg.stateDir, cfg.moa.enabled); // persist across restarts
      // Auto-switch the active model to match: fleet/moa when on, fleet/auto when off.
      const target = cfg.moa.enabled ? "moa" : "auto";
      const ok = await switchFleetModel(pi, ctx, target);
      report(ctx, `MoA ${cfg.moa.enabled ? "enabled" : "disabled"} (${cfg.moa.workers} workers, policy=${cfg.moa.policy}).` + (ok ? ` Model → fleet/${target}.` : ""));
    },
  });

  pi.registerCommand("fleet-evolve", {
    description: "Run one self-evolution cycle now (bounded, reversible)",
    handler: (_args: string, ctx: PiCommandCtx) => {
      status(ctx, "Fleet: running self-evolution cycle…");
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
  pi.on("session_start", async (_e: unknown, ctx: PiEventCtx) => {
    // Make sure the Camofox stealth browser is running for keyless discovery.
    if (cfg.discovery.censys.enabled && cfg.discovery.censys.browser.enabled) ensureCamofox();
    // Fire-and-forget: discovery + probing must NOT block pi startup.
    void orch.start().catch(() => {});
    // If MoA was left enabled, make fleet/moa the active model on startup.
    if (cfg.moa.enabled) void switchFleetModel(pi, ctx, "moa");
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

const STATUS_ID = "pi-fleet";

/** Set the keyed footer status line (live feedback during a command). */
function status(ctx: PiCommandCtx, msg: string): void {
  try { ctx.ui?.setStatus?.(STATUS_ID, msg); } catch { /* non-TUI */ }
}

/** Emit the final result and clear any live status. */
function report(ctx: PiCommandCtx, msg: string): void {
  status(ctx, "");
  if (ctx.ui?.notify) ctx.ui.notify(msg, "info");
  else console.log(msg);
}

function firstLine(s: string): string {
  return (s.split("\n").find((l) => l.trim()) ?? s).slice(0, 200);
}

// --- MoA state persistence ---------------------------------------------------

function moaStatePath(stateDir: string): string {
  return join(stateDir, "moa.json");
}

/** Read persisted MoA on/off, or null if never set. */
function loadMoaState(stateDir: string): boolean | null {
  try {
    return JSON.parse(readFileSync(moaStatePath(stateDir), "utf8")).enabled === true;
  } catch {
    return null;
  }
}

function saveMoaState(stateDir: string, enabled: boolean): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(moaStatePath(stateDir), JSON.stringify({ enabled }));
  } catch { /* best-effort */ }
}

/** Switch the active model to fleet/<target> ("moa" | "auto"). */
async function switchFleetModel(pi: PiExtensionAPI, ctx: PiEventCtx, target: "moa" | "auto"): Promise<boolean> {
  try {
    const model = ctx.modelRegistry?.find?.(PROVIDER, target);
    if (model && pi.setModel) return await pi.setModel(model);
  } catch { /* model registry not ready */ }
  return false;
}
