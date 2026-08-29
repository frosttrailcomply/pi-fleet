import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FleetConfig } from "./types.ts";

/** Sensible defaults. Every knob is overridable via fleet.config.json or env. */
export const DEFAULT_CONFIG: FleetConfig = {
  routing: {
    capability: 1.0,
    latency: 0.8,
    throughput: 0.5,
    health: 1.2,
    reliability: 1.0,
    context: 0.3,
  },
  health: {
    failureThreshold: 3,
    cooldownMs: 30_000,
    recoveryThreshold: 2,
    requestTimeoutMs: 15_000,
    ewmaAlpha: 0.3,
  },
  discovery: {
    enabled: true,
    refreshIntervalMs: 15 * 60_000,
    healthProbeIntervalMs: 60_000,
    concurrency: 100,
    censys: {
      enabled: true,
      query: 'host.services.software.product = "ollama" or web.software.product = "ollama"',
      htmlImports: [],
      apiIdEnv: "CENSYS_API_ID",
      apiSecretEnv: "CENSYS_API_SECRET",
      browser: {
        enabled: true,
        // Default: pi-fleet's Camofox scraper, which drives the browser-search
        // Camofox (camoufox) service, waits for the result anchors to render,
        // and prints the full HTML. Requires the Camofox container running and
        // CAMOFOX_API_KEY set (see scripts/setup-browser-search.mjs). PI_FLEET_DIR
        // is set by the extension/CLI to this package's root.
        command: ["node", "${PI_FLEET_DIR}/scripts/censys-camofox.mjs", "{url}"],
        searchUrl: "https://platform.censys.io/search?q={query}",
        resultPath: "",
        timeoutMs: 120_000,
      },
    },
    seeds: [],
    defaultPorts: [11434],
  },
  moa: {
    enabled: false,
    workers: 3,
    workerModels: [],
    aggregatorModel: "",
    parallelism: 3,
    timeoutMs: 45_000,
    policy: "diverse",
    minWorkers: 1,
  },
  memory: {
    enabled: true,
    backend: "hindsight",
    fallbackToNative: true,
    hindsight: {
      baseUrl: "http://127.0.0.1:8765",
      apiKeyEnv: "HINDSIGHT_API_KEY",
      namespace: "pi-fleet",
      timeoutMs: 10_000,
    },
    dbPath: "",
    topK: 5,
    minScore: 0.15,
  },
  evolution: {
    enabled: false,
    intervalMs: 60 * 60_000,
    minObservations: 5,
    workDir: "",
    autoApply: false,
  },
  providers: [],
  gatewayPort: 47600,
  stateDir: "",
};

/** Resolve "$ENV_VAR"/"${ENV_VAR}" api keys against the environment. */
export function resolveSecret(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^\$\{?([A-Z0-9_]+)\}?$/);
  return m ? process.env[m[1]!] : v;
}

/** Deep-merge partial overrides onto a base config (arrays replace). */
function mergeConfig<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = Array.isArray(base) ? [...(base as unknown[])] as never : { ...(base as object) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const bv = (base as Record<string, unknown>)[k];
    out[k] = bv && typeof bv === "object" && !Array.isArray(bv) ? mergeConfig(bv, v) : v;
  }
  return out as T;
}

/** Resolve the state directory (transient, gitignored). */
export function stateDir(): string {
  return process.env.PI_FLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet");
}

/**
 * Load config from (in priority order): explicit path arg, $PI_FLEET_CONFIG,
 * ./fleet.config.json, ~/.pi/agent/fleet.config.json — merged onto defaults.
 * Missing files are fine; defaults win.
 */
export function loadConfig(explicitPath?: string): FleetConfig {
  const candidates = [
    explicitPath,
    process.env.PI_FLEET_CONFIG,
    join(process.cwd(), "fleet.config.json"),
    join(homedir(), ".pi", "agent", "fleet.config.json"),
  ].filter(Boolean) as string[];

  let cfg: FleetConfig = structuredClone(DEFAULT_CONFIG);
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        cfg = mergeConfig(cfg, raw);
        break;
      } catch (e) {
        // Bad config should not crash pi; warn and continue with defaults.
        console.error(`[pi-fleet] failed to parse config ${path}: ${(e as Error).message}`);
      }
    }
  }

  // Fill derived path defaults.
  const dir = cfg.stateDir || stateDir();
  cfg.stateDir = dir;
  if (!cfg.memory.dbPath) cfg.memory.dbPath = join(dir, "memory.sqlite");
  if (!cfg.evolution.workDir) cfg.evolution.workDir = join(process.cwd(), ".pi", "fleet-evolution");
  return cfg;
}

export { mergeConfig };
