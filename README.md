<div align="center">

# pi-fleet

**A self-healing fleet of models for the [Pi coding agent](https://github.com/earendil-works/pi)** — discovers OpenAI-compatible and Ollama endpoints, tracks their health, and routes every request to the best one with transparent failover. Optional Mixture of Agents and a learning memory.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-75%20passing-brightgreen.svg)](test)
[![Built for Pi](https://img.shields.io/badge/built%20for-Pi%20coding%20agent-8A2BE2.svg)](https://github.com/earendil-works/pi)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

**English** · [Русский](README.ru.md) · [中文](README.zh.md) · [Deutsch](README.de.md)

[Install](#install) · [Configure](#configure) · [Use in Pi](#use-in-pi) · [How it works](#how-it-works) · [Test](#test)

</div>

Everything runs alongside Pi's own providers — they keep working unchanged. pi-fleet is a package, not a fork.

## What you get

- **Dynamic fleet** — background discovery (local seeds, keyless Censys scrape, or the Censys API), liveness + latency/throughput probes, per-endpoint circuit breakers, and routing weighted by model capability, latency, throughput, health, reliability, and context window.
- **Transparent failover** — a request that hits a slow or broken endpoint is retried on the next-best one; the breaker opens after repeated failures and recovers on its own.
- **Mixture of Agents (MoA)** — optional. Runs several models in parallel and has an aggregator synthesize one answer. Works across local and external providers, and degrades gracefully when workers fail.
- **Memory** — learns pitfalls and workarounds from tool outcomes and injects the relevant ones before a turn. Bounded, reversible **self-evolution** tunes fleet configuration against a measured metric. Backed by [Hindsight](https://github.com/vectorize-io/hindsight) when available, and a zero-dependency local SQLite store otherwise.

## Install

```bash
pi install git:github.com/<you>/pi-fleet      # or: pi install npm:pi-fleet
# or load the extension directly:
pi -e /path/to/pi-fleet/src/ext/fleet-extension.ts
```

Requires Node ≥ 22 (it uses the built-in `node:sqlite`). Pi discovers the extension through the `pi` key in `package.json`.

## Configure

Put a `fleet.config.json` in the working directory, in `~/.pi/agent/`, or point `PI_FLEET_CONFIG` at one. Every field is optional; defaults are in [`examples/fleet.config.json`](examples/fleet.config.json). The parts you are most likely to touch:

```jsonc
{
  "gatewayPort": 47600,             // local port Pi talks to (see "How it works")
  "discovery": {
    "seeds": ["127.0.0.1:11434"],   // local Ollama and any host:port you own
    "censys": {
      "enabled": true,
      "query": "host.services.software.product = \"ollama\" or web.software.product = \"ollama\"",
      "browser": { "enabled": true } // keyless live scrape (default) — see below
    }
  },
  "routing": { "capability": 1.0, "latency": 0.8, "throughput": 0.5, "health": 1.2, "reliability": 1.0, "context": 0.3 },
  "moa": { "enabled": false, "workers": 3, "policy": "diverse", "aggregatorModel": "", "minWorkers": 1 },
  "memory": { "enabled": true, "backend": "hindsight", "fallbackToNative": true },
  "evolution": { "enabled": false, "autoApply": false },
  "providers": [                    // external / local OpenAI-compatible endpoints in the pool
    { "id": "openrouter", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "$OPENROUTER_API_KEY",
      "models": [{ "id": "meta-llama/llama-3.1-70b-instruct", "sizeB": 70, "contextWindow": 131072 }] }
  ]
}
```

### Discovery (keyless by default)

The Censys web UI sits behind Cloudflare and a login wall, so a plain HTTP request only returns a challenge page. pi-fleet therefore renders the results through the [browser-search](https://github.com/Johell1NS/browser-search) stack (Camofox / camoufox stealth browser) and parses host:port out of the rendered HTML — **no Censys API key**.

**Setup** — install the browser-search stack and start its Camofox container:

```bash
npm run setup:browser-search   # clone + install browser-search, start Camofox on 127.0.0.1:9377
```

This also runs automatically on `npm install` (code only — it clones and installs browser-search but does not start the container; skipped in CI or with `PI_FLEET_SKIP_SETUP=1`). It needs `git`, and `podman` or `docker` for the container. When it finishes it prints the credential to export:

```bash
export CAMOFOX_API_KEY=<generated key>   # must match the running Camofox container
```

That is the only credential the keyless path needs. `BROWSER_SEARCH_DIR` is written for you and `PI_FLEET_DIR` (used to locate the default scrape command) is set by the extension and CLI automatically.

Any fetcher that prints rendered HTML also works — point `discovery.censys.browser.command` at it. For example, Firecrawl:

```jsonc
"command": ["firecrawl", "scrape", "{url}", "--format", "html", "--wait-for", "9000"],
"resultPath": ""
```

The sources compose: `discovery.seeds`, saved Censys pages via `discovery.censys.htmlImports`, and the Censys API when `CENSYS_API_ID` / `CENSYS_API_SECRET` are set. Discovered hosts are probed (`/api/tags` → a real chat completion) and only verified endpoints join the fleet. A live keyless run through this path discovered 70+ reachable endpoints.

> Only point discovery at endpoints you are authorized to use.

### Memory backend

`memory.backend` defaults to `"hindsight"`. At startup pi-fleet probes the Hindsight service (`memory.hindsight.baseUrl`); if it answers, lessons are retained and recalled there. If it does not, and `fallbackToNative` is true (the default), the local SQLite store takes over — so memory works with no external service. The native store always runs regardless, because it drives self-evolution.

Run Hindsight yourself (Docker/Postgres) per its docs, then set `memory.hindsight.baseUrl` and, if needed, `HINDSIGHT_API_KEY`.

## Use in Pi

Select the fleet as your model:

```bash
pi --provider fleet --model auto                          # capability/health-weighted routing + failover
pi --provider fleet --model moa                           # Mixture of Agents (when moa.enabled)
pi --provider fleet --model "127.0.0.1:11434/llama3.1:70b" # pin a specific discovered model
```

Commands:

| Command | Effect |
|---|---|
| `/fleet` | Endpoints, health, breaker state, models, memory backend |
| `/fleet-refresh` | Force an immediate discovery + health refresh |
| `/fleet-moa on\|off` | Toggle Mixture of Agents |
| `/fleet-evolve` | Run one bounded self-evolution cycle now |
| `/fleet-remember <text>` | Store an environment fact / lesson |

## Standalone CLI

Operate the fleet without launching Pi:

```bash
npm run fleetctl -- discover        # one discovery + health pass, print status
npm run fleetctl -- status
npm run fleetctl -- import page.html   # extract host:port from a saved Censys page
npm run fleetctl -- chat "hello"    # route one prompt through the fleet
npm run fleetctl -- memory          # list stored lessons
```

## How it works

Pi talks to a small local **gateway** (`gatewayPort`) as an ordinary OpenAI-compatible provider. The gateway routes each request through the engine, so all of Pi's model handling stays on its supported path:

```
discovery (seeds / browser-scrape / Censys API) → probe → registry (EWMA stats + circuit breaker)
                                                            │
        request ──► router (weighted score) ──► failover executor ──► endpoint
                                                    └► MoA: parallel workers → aggregator
observations ──► memory (Hindsight or native SQLite) ──► self-improvement / self-evolution
```

- **Circuit breaker** — `failureThreshold` consecutive failures open an endpoint; after `cooldownMs` it half-opens for a trial; `recoveryThreshold` successes close it.
- **Self-evolution** — bounded and reversible. It auto-applies only *configuration* changes (quarantining a flaky endpoint, nudging routing weights) that measurably improve a metric, and rolls back otherwise. Anything touching code or skills is written as a git-tracked, review-only proposal under `.pi/fleet-evolution/`.

Transient state lives under `~/.pi/agent/fleet/` (native memory database, evolution artifacts). Nothing sensitive is committed.

## Test

```bash
npm test          # unit + integration + end-to-end (in-process mock endpoints; no external hosts)
npm run typecheck
```

The end-to-end suite (`test/e2e.test.ts`) covers discovery and refresh, health transitions, routing, transparent failover, endpoint recovery, local + external interoperability, MoA success and partial-worker failure, pitfall persistence and retrieval, the scheduled loops, self-evolution accept and rollback, and a clean restart with persisted state.

## Credits

Built on the work of:

- **[browser-search](https://github.com/Johell1NS/browser-search)** by [@Johell1NS](https://github.com/Johell1NS) — the Camofox (camoufox) / CloakBrowser stack that powers keyless Censys discovery.
- **[Pi coding agent](https://github.com/earendil-works/pi)** by [earendil-works](https://github.com/earendil-works) — the host agent this extends.
- **[Hindsight](https://github.com/vectorize-io/hindsight)** by [vectorize-io](https://github.com/vectorize-io) — the default memory backend.
- **[Firecrawl](https://github.com/firecrawl/firecrawl)** — an alternative rendered-HTML fetcher for discovery.

The discovery pipeline began as a pair of Python scripts (`extract_ollama_hosts.py`, `ollama_recon.py`) and was ported to TypeScript here.

## License

MIT — see [LICENSE](LICENSE).
