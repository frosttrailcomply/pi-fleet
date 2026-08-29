You are the principal engineer and autonomous implementer for this project. Your job is to deliver a working enhancement to **Pi Coding Agent**, not merely design it.

## Objective

Build an extension/package for Pi that adds a resilient, dynamically refreshed model fleet, MoA, persistent learning, and controlled self-improvement. Prefer a Pi extension/package over a fork because Pi already supports dynamic providers/models; fork Pi only if you verify that a required capability cannot be implemented cleanly through public extension/provider/session APIs.

Work autonomously from repository inspection to a tested finished product. Do not ask me to make architectural choices you can resolve through research, code inspection, or experiments.

## Existing assets

Inspect and reuse/refactor these scripts rather than blindly rewriting them:

`C:\Users\user\Desktop\BoxPwner\extract_ollama_hosts.py`
`C:\Users\user\Desktop\BoxPwner\ollama_recon.py`

They currently form a pipeline roughly equivalent to:

Censys HTML → deduplicated `host:port` inventory → async `/api/tags` discovery → real `/v1/chat/completions` probe → active model inventory.

Preserve useful behavior, but integrate it properly into the product instead of shelling together fragile scripts if a cleaner implementation is justified.

## Required capabilities

### Dynamic model fleet

Continuously maintain a live registry of configured external providers plus discovered/local OpenAI-compatible or Ollama endpoints.

Support:

* background discovery/refresh;
* configurable health and liveness probes;
* latency and throughput measurements using rolling statistics;
* failure counters, circuit breakers, cooldown/recovery, and seamless failover;
* dynamic addition/removal of models without restarting Pi where its API permits;
* routing that favors model capability/size while also accounting for latency, throughput, health, context size, and recent reliability;
* configurable routing weights and sensible defaults.

Integrate periodic Censys discovery using the query intent:

`host.services.software.product = "ollama" or web.software.product = "ollama"`

Prefer an official supported Censys API/SDK when credentials are available; retain saved-HTML ingestion as a fallback/import path (can use browser-search (https://github.com/Johell1NS/browser-search) or similar).

### Mixture of Agents

Implement optional/configurable MoA.

It should execute useful independent workers in parallel and synthesize them through an aggregator rather than merely asking the same model repeatedly.

Configuration should cover at least:

* enabled/disabled;
* number/model selection of workers;
* aggregator selection;
* parallelism;
* timeout;
* routing policy;
* graceful degradation when workers fail.

MoA must work across both local models and normal external Pi providers.

### Memory and self-improvement

Implement two independently toggleable subsystems:

**Self-improvement:** observe sessions/tool outcomes, preserve useful lessons, pitfalls, environment facts, recurring failures, successful workarounds, and retrieve them when relevant.

**Self-evolution:** periodically analyze measurable failures or repeated inefficiencies and propose/apply targeted improvements to allowed agent skills/configuration/code.

Research the current ecosystem before choosing an implementation. The products I mentioned — Hermes mechanisms, OpenViking, mem0, Hindsight, Chronos, Mastra, Supermemory, Graphiti/Zep, Letta, Cognee, MemOS, MemMachine, Memori, memU, Memobase, LangMem, A-MEM, MemoryOS, ReMe, Memary, MIRIX, Memory-R1, SimpleMem, LightMem, Memvid, Honcho, OpenMemory, OMEGA, agentmemory, etc. — are candidates, not requirements.

Choose based on technical fit, maintenance burden, local-first capability, retrieval quality, portability, and token/runtime overhead. Do not add a framework merely because it exists; a small native implementation is preferable when it solves the problem better.

Self-evolution must be bounded and reversible:

observe → identify measurable weakness → create minimal change → test/evaluate → accept or rollback → record lesson.

Never let autonomous evolution silently degrade the working system. Keep changes scoped, git-tracked, test-gated, and reversible.

Both mechanisms need configurable schedules and must be disableable.

## Engineering principles

Think before coding, but avoid analysis paralysis.

Inspect the current Pi architecture and latest official APIs first. Use supported extension hooks such as dynamic provider/model registration and refresh where possible instead of patching core internals.

Favor simple composable components and adapters over a large framework.

Keep local models first-class citizens. External providers must continue working normally.

Avoid wasting tokens on development diaries, speculative architecture documents, or duplicated docs. Produce only minimal product documentation covering installation, configuration, commands, and operation.

Use Git from the beginning. Make meaningful incremental commits. Keep generated artifacts, credentials, caches, and transient discovery data out of Git.

Persist important pitfalls and verified workarounds in the project's agent memory so they are not rediscovered repeatedly.

Keep the Windows host clean. Prefer WSL2 and/or Podman containers for development, services, builds, and integration tests where practical.

Never commit secrets.

## Parallel execution

Use parallel subagents whenever the environment supports them and tasks are independent.

Use:

* Haiku-class workers for cheap reconnaissance, code searching, simple tests, and mechanical work;
* Sonnet-class workers for normal implementation/debugging;
* Opus-class reasoning for architecture, difficult debugging, integration decisions, and orchestration.

Do not parallelize tightly coupled edits simply for the sake of parallelism, and do not duplicate work across agents.

## Validation

A feature is not complete because it compiles.

Build automated tests plus an end-to-end test environment using disposable/local or mocked authorized endpoints.

At minimum verify:

1. provider/model discovery and live refresh;
2. endpoint health transitions;
3. routing/scoring behavior;
4. transparent failover during an active failure;
5. recovery of a previously unhealthy endpoint;
6. local + external-provider interoperability;
7. MoA success and partial-worker failure;
8. persistence/retrieval of learned pitfalls;
9. scheduled self-improvement;
10. self-evolution acceptance and rollback paths;
11. clean restart with persisted state/config.

Run the real E2E suite. If anything fails, debug it and repeat the loop until it passes or there is a genuine external blocker you cannot remove.

## Definition of done

Deliver a working Git repository with:

* the implementation;
* sensible example configuration;
* automated unit/integration/E2E tests;
* minimal README/user documentation;
* no unnecessary host pollution;
* no unresolved known test failures.

At completion, give me only a concise report containing:

* what you built;
* the important architectural choices and why;
* how to run/configure it;
* exact E2E test results;
* any genuine remaining limitations.

Spend tokens on working software and verification, not narration.