# pi-fleet

A [Pi coding agent](https://github.com/earendil-works/pi) extension that adds a **resilient dynamic model fleet**, **Mixture of Agents (MoA)**, and **local-first self-improving memory** — for local and external OpenAI-compatible / Ollama models alike.

- **Dynamic fleet** — continuously discovers, health-checks, and ranks endpoints; routes by capability + latency + throughput + health + reliability with circuit-breaking and transparent failover.
- **MoA** — optional parallel workers synthesized by an aggregator, across local *and* external providers.
- **Memory** — self-improvement (learns pitfalls/workarounds from tool outcomes) and bounded, reversible self-evolution.

It ships as a Pi package (not a fork): Pi keeps working normally, and its own providers are untouched.

## Install

```bash
# From this repo (project-local or global)
pi install git:github.com/<you>/pi-fleet        # or: pi install npm:pi-fleet
# Or load the extension file directly:
pi -e /path/to/pi-fleet/src/ext/fleet-extension.ts
```

Requires Node ≥ 22 (uses built-in `node:sqlite`). Pi picks the extension up via the `pi` key in `package.json`.

## Configure

Drop a `fleet.config.json` in the working directory, at `~/.pi/agent/fleet.config.json`, or point `PI_FLEET_CONFIG` at one. All keys are optional; sensible defaults apply. See [`examples/fleet.config.json`](examples/fleet.config.json).

```jsonc
{
  "gatewayPort": 47600,           // local OpenAI-compatible gateway pi talks to
  "discovery": {
    "enabled": true,
    "seeds": ["127.0.0.1:11434"], // local Ollama, or any host:port
    "refreshIntervalMs": 900000,
    "healthProbeIntervalMs": 60000,
    "censys": {
      "enabled": false,
      "query": "host.services.software.product = \"ollama\" or web.software.product = \"ollama\"",
      "htmlImports": ["/path/to/saved-censys.html"], // credential-free fallback
      "apiIdEnv": "CENSYS_API_ID", "apiSecretEnv": "CENSYS_API_SECRET"
    }
  },
  "routing": { "capability": 1.0, "latency": 0.8, "throughput": 0.5, "health": 1.2, "reliability": 1.0, "context": 0.3 },
  "moa": { "enabled": false, "workers": 3, "policy": "diverse", "aggregatorModel": "", "timeoutMs": 45000, "minWorkers": 1 },
  "memory": { "enabled": true, "topK": 5, "minScore": 0.15 },
  "evolution": { "enabled": false, "intervalMs": 3600000, "minObservations": 5, "autoApply": false },
  "providers": [                  // external/local OpenAI-compatible providers joined into the pool
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "meta-llama/llama-3.1-70b-instruct", "sizeB": 70, "contextWindow": 131072 }] }
  ]
}
```

### Censys discovery

Set `discovery.censys.enabled: true`. If `CENSYS_API_ID` / `CENSYS_API_SECRET` are present the Platform API is used; otherwise (or additionally) list saved Censys results pages under `htmlImports` for a credential-free import path. Discovered hosts are probed (`/api/tags` → real chat completion) and only verified endpoints join the fleet.

> Only point discovery at endpoints you are authorized to use.

## Use in Pi

Select the fleet as your model:

```bash
pi --provider fleet --model auto      # capability/health-weighted routing + failover
pi --provider fleet --model moa       # Mixture of Agents (when moa.enabled)
pi --provider fleet --model "127.0.0.1:11434/llama3.1:70b"   # pin a discovered model
```

Commands:

| Command | What it does |
|---|---|
| `/fleet` | Show endpoints, health, breaker state, models, memory |
| `/fleet-refresh` | Force an immediate discovery + health refresh |
| `/fleet-moa on\|off` | Toggle Mixture of Agents |
| `/fleet-evolve` | Run one bounded self-evolution cycle now |
| `/fleet-remember <text>` | Store an environment fact / lesson |

## Standalone CLI

Operate the fleet without launching Pi:

```bash
npm run fleetctl -- discover        # one discovery+health pass, print status
npm run fleetctl -- status
npm run fleetctl -- import saved-censys.html   # extract host:port from saved HTML
npm run fleetctl -- chat "hello"    # route one prompt through the fleet
npm run fleetctl -- memory          # list stored lessons
```

## How it works

Pi talks to a small local **FleetGateway** (`gatewayPort`) as an ordinary OpenAI-compatible provider. The gateway routes each request through the engine:

```
discovery (seeds / Censys) → probe → registry (EWMA stats + circuit breaker)
                                        │
        request ──► router (weighted score) ──► failover executor ──► endpoint
                                        └► MoA: parallel workers → aggregator
observations ──► memory (sqlite lessons) ──► self-improvement / self-evolution
```

- **Circuit breaker**: `failureThreshold` consecutive failures open an endpoint; after `cooldownMs` it half-opens for a trial; `recoveryThreshold` successes close it.
- **Self-evolution** is bounded and reversible: it only auto-applies *configuration* changes (endpoint quarantine, routing-weight tweaks) that measurably improve a metric, rolling back otherwise; code/skill changes are emitted as git-tracked review-only proposals under `.pi/fleet-evolution/`.

State lives under `~/.pi/agent/fleet/` (memory sqlite, evolution artifacts); nothing sensitive is committed.

## Test

```bash
npm test          # unit + integration + E2E (in-process mock endpoints; no external hosts)
npm run typecheck
```

The E2E suite (`test/e2e.test.ts`) validates discovery/refresh, health transitions, routing, transparent failover, recovery, local+external interop, MoA (success + partial-failure), pitfall persistence/retrieval, scheduled loops, evolution accept/rollback, and clean restart with persisted state.

## License

MIT
