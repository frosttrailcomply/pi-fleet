// Shared vocabulary for the pi-fleet engine.
// Kept dependency-free so every module (and the tests) can import it cheaply.

/** Health state of an endpoint, driven by the circuit breaker. */
export type Health = "healthy" | "degraded" | "unhealthy";

/** How an endpoint entered the registry. */
export type EndpointSource = "config" | "censys" | "local" | "manual" | "import";

/** Wire API an endpoint speaks. Ollama servers speak both native + openai-compat. */
export type EndpointApi = "ollama" | "openai-completions";

/** A discovered or configured OpenAI-compatible / Ollama endpoint. */
export interface Endpoint {
  /** Canonical id: `host:port` for discovered, provider name for configured. */
  id: string;
  host: string;
  port: number;
  baseUrl: string;
  api: EndpointApi;
  source: EndpointSource;
  /** Optional bearer key for authed OpenAI-compatible endpoints. */
  apiKey?: string;
  /** Models observed live on this endpoint. */
  models: ModelInfo[];
  firstSeen: number;
  lastSeen: number;
}

/** A concrete model available on an endpoint. */
export interface ModelInfo {
  /** Provider-native model id, e.g. `llama3.1:70b`. */
  id: string;
  /** Parsed parameter size in billions, best-effort from the name/tag. 0 if unknown. */
  sizeB: number;
  /** Context window in tokens if known, else a conservative default. */
  contextWindow: number;
  /** True once a real chat completion succeeded. */
  verified: boolean;
}

/** Rolling performance + reliability stats for one endpoint (or endpoint/model). */
export interface Stats {
  /** Exponentially-weighted mean latency (ms) of the first byte / full response. */
  latencyMs: number;
  /** Exponentially-weighted throughput (tokens/sec). 0 until measured. */
  throughputTps: number;
  /** Total successful calls. */
  successes: number;
  /** Total failed calls. */
  failures: number;
  /** Consecutive failures since last success (drives the breaker). */
  consecutiveFailures: number;
  /** Consecutive successes since last failure (drives half-open -> closed). */
  consecutiveSuccesses: number;
  /** Epoch ms of last successful call. */
  lastSuccess: number;
  /** Epoch ms of last failure. */
  lastFailure: number;
}

/** Circuit-breaker phase. */
export type BreakerState = "closed" | "open" | "half-open";

/** Full runtime record the registry keeps per endpoint. */
export interface EndpointRecord {
  endpoint: Endpoint;
  stats: Stats;
  breaker: BreakerState;
  /** Epoch ms the breaker opened; used to compute cooldown expiry. */
  openedAt: number;
  health: Health;
}

/** A single scored routing candidate. */
export interface Candidate {
  endpointId: string;
  modelId: string;
  score: number;
  breakdown: Record<string, number>;
}

/** Tunable routing weights. All default in config.ts. */
export interface RoutingWeights {
  capability: number; // favors larger / more capable models
  latency: number; // favors lower latency
  throughput: number; // favors higher tokens/sec
  health: number; // favors healthy endpoints
  reliability: number; // favors low recent failure rate
  context: number; // favors larger context windows
}

/** Circuit-breaker + probe tuning. */
export interface HealthConfig {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold: number;
  /** Cooldown (ms) before an open breaker moves to half-open. */
  cooldownMs: number;
  /** Consecutive half-open successes needed to fully close. */
  recoveryThreshold: number;
  /** Per-request timeout (ms) for probes and calls. */
  requestTimeoutMs: number;
  /** EWMA smoothing factor (0..1); higher = react faster. */
  ewmaAlpha: number;
}

/** Discovery / refresh tuning. */
export interface DiscoveryConfig {
  enabled: boolean;
  /** Background full-refresh interval (ms). */
  refreshIntervalMs: number;
  /** Health-probe-only interval (ms). */
  healthProbeIntervalMs: number;
  /** Max concurrent probe requests. */
  concurrency: number;
  /** Censys integration. */
  censys: {
    enabled: boolean;
    /** Query intent used against the Censys API. */
    query: string;
    /** Saved-HTML files to ingest as a fallback/import path. */
    htmlImports: string[];
    /** API id/secret env var names (never store secrets in config). */
    apiIdEnv: string;
    apiSecretEnv: string;
    /**
     * Keyless live scrape via an external, browser-capable fetcher (e.g.
     * browser-search's smart-extract / CloakBrowser, or Firecrawl). The command
     * is run with {url} substituted; its stdout (optionally a JSON field named
     * by resultPath) is parsed for host:port pairs. No Censys API key required.
     */
    browser: BrowserScrapeConfig;
  };
  /** Statically configured seed endpoints (host:port or full baseUrl). */
  seeds: string[];
  /** Default ports to probe for bare hosts. */
  defaultPorts: number[];
}

/** MoA (Mixture of Agents) tuning. */
export interface MoaConfig {
  enabled: boolean;
  /** Number of parallel worker proposals. */
  workers: number;
  /** Explicit worker model ids (endpointId/modelId or provider/model). Empty = auto-pick. */
  workerModels: string[];
  /** Aggregator model id. Empty = auto-pick strongest healthy. */
  aggregatorModel: string;
  /** Max in-flight workers. */
  parallelism: number;
  /** Per-worker timeout (ms). */
  timeoutMs: number;
  /** Routing policy for auto worker selection. */
  policy: "diverse" | "strongest" | "fastest";
  /** Minimum successful workers required to still aggregate. */
  minWorkers: number;
}

/** Keyless browser-based scrape via an external fetcher command. */
export interface BrowserScrapeConfig {
  enabled: boolean;
  /**
   * Command + args run to fetch a URL. `{url}` is substituted in any arg.
   * Default targets browser-search's smart-extract (CloakBrowser-backed);
   * set BROWSER_SEARCH_DIR so the default path resolves.
   */
  command: string[];
  /** Search URL template; `{query}` is URL-encoded and substituted. */
  searchUrl: string;
  /**
   * Dot-path into the command's JSON stdout that holds the HTML/text to parse
   * (e.g. "results.0.content" for smart-extract). Empty = treat stdout as raw HTML.
   */
  resultPath: string;
  /** Per-invocation timeout (ms). */
  timeoutMs: number;
}

/** Which memory backend the fleet uses. */
export type MemoryBackendKind = "hindsight" | "native";

/** Hindsight memory service connection (optional external backend). */
export interface HindsightConfig {
  /** Base URL of a running Hindsight service. */
  baseUrl: string;
  /** Bearer token env var name (never store the token itself). */
  apiKeyEnv: string;
  /** Namespace/agent id used to scope memories. */
  namespace: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
}

/** Memory (self-improvement) tuning. */
export interface MemoryConfig {
  enabled: boolean;
  /**
   * Preferred backend. "hindsight" is the default choice; if the service is
   * unreachable at startup the fleet transparently falls back to the native
   * local-first SQLite store, so it always works out of the box.
   */
  backend: MemoryBackendKind;
  /** Fall back to the native store when the preferred backend is unavailable. */
  fallbackToNative: boolean;
  hindsight: HindsightConfig;
  /** SQLite file path (native backend). */
  dbPath: string;
  /** Max lessons returned per retrieval. */
  topK: number;
  /** Minimum score for a lesson to be injected. */
  minScore: number;
}

/** Self-evolution tuning. */
export interface EvolutionConfig {
  enabled: boolean;
  /** Analysis interval (ms). */
  intervalMs: number;
  /** Min observations of a weakness before proposing a change. */
  minObservations: number;
  /** Directory the evolver may write proposals/patches into (git-tracked). */
  workDir: string;
  /** Auto-apply accepted proposals, or require manual approval. */
  autoApply: boolean;
}

/** A statically configured OpenAI-compatible provider joined into the fleet pool. */
export interface ProviderConfigEntry {
  id: string;
  baseUrl: string;
  /** Literal, or "$ENV_VAR" (resolved at load). */
  apiKey?: string;
  api?: EndpointApi;
  models: Array<{ id: string; sizeB?: number; contextWindow?: number }>;
}

export interface FleetConfig {
  routing: RoutingWeights;
  health: HealthConfig;
  discovery: DiscoveryConfig;
  moa: MoaConfig;
  memory: MemoryConfig;
  evolution: EvolutionConfig;
  /**
   * Extra OpenAI-compatible providers (local vLLM/LM Studio, or external hosted
   * gateways) added to the routing/MoA pool alongside discovered endpoints.
   * Pi's own configured providers are unaffected and keep working normally.
   */
  providers: ProviderConfigEntry[];
  /** Local port the OpenAI-compatible fleet gateway binds (pi talks to this). */
  gatewayPort: number;
  /** Directory for transient runtime state (gitignored). */
  stateDir: string;
}

/** Minimal chat message shape used across engine + adapters (OpenAI-ish). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  endpointId: string;
  modelId: string;
  latencyMs: number;
  tokens: number;
  throughputTps: number;
}

/** A stored lesson / environment fact / pitfall. */
export interface Lesson {
  id?: number;
  kind: "lesson" | "pitfall" | "env-fact" | "workaround" | "failure";
  text: string;
  tags: string[];
  /** Free context, e.g. tool name, cwd, error signature. */
  context: string;
  weight: number;
  createdAt: number;
  lastUsed: number;
  uses: number;
}
