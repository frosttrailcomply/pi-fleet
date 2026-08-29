#!/usr/bin/env -S node --experimental-sqlite --import tsx
// Standalone fleet control CLI. Drives the same FleetOrchestrator the pi
// extension uses, so discovery/routing/memory can be operated and inspected
// without launching pi (also used by the E2E suite and for ops).
//
//   fleetctl discover              run one discovery+health refresh, print status
//   fleetctl status                print current fleet status (from a fresh init)
//   fleetctl import <html...>      extract host:port from saved Censys HTML
//   fleetctl chat <text>           route one prompt through the fleet
//   fleetctl memory                list stored lessons

import { loadConfig } from "../engine/config.ts";
import { FleetOrchestrator } from "../engine/orchestrator.ts";
import { extractFromFiles } from "../engine/discovery/censys.ts";

function printStatus(orch: FleetOrchestrator): void {
  const s = orch.status();
  console.log(`endpoints=${s.endpoints.length} models=${s.totalModels} moa=${s.moaEnabled} memory=${s.memoryLessons} evolution=${s.evolutionEnabled}`);
  for (const e of s.endpoints) {
    console.log(`  ${e.health.padEnd(9)} ${e.breaker.padEnd(9)} ${String(e.models).padStart(3)}m ${String(e.latencyMs).padStart(6)}ms rel=${e.reliability} [${e.source}] ${e.id}`);
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case "import": {
      if (args.length === 0) { console.error("usage: fleetctl import <html...>"); return 2; }
      for (const hp of extractFromFiles(args)) console.log(`${hp.host}:${hp.port}`);
      return 0;
    }
    case "discover": {
      const orch = new FleetOrchestrator(cfg);
      orch.init();
      const n = await orch.refresher.runFullRefresh();
      await orch.refresher.runHealthProbe();
      console.error(`[fleetctl] discovered/updated ${n} endpoints`);
      printStatus(orch);
      orch.stop();
      return 0;
    }
    case "status": {
      const orch = new FleetOrchestrator(cfg);
      orch.init();
      printStatus(orch);
      orch.stop();
      return 0;
    }
    case "chat": {
      const text = args.join(" ");
      if (!text) { console.error("usage: fleetctl chat <text>"); return 2; }
      const orch = new FleetOrchestrator(cfg);
      orch.init();
      await orch.refresher.runFullRefresh();
      const out = cfg.moa.enabled
        ? { result: { content: (await orch.moaChat({ messages: [{ role: "user", content: text }] })).content, endpointId: "moa", modelId: "moa" } }
        : await orch.chat({ messages: [{ role: "user", content: text }] });
      if (out.result) console.log(out.result.content);
      else { console.error("[fleetctl] no endpoint answered"); orch.stop(); return 1; }
      orch.stop();
      return 0;
    }
    case "memory": {
      const orch = new FleetOrchestrator(cfg);
      for (const l of orch.memory?.all() ?? []) console.log(`[${l.kind}] w=${l.weight} ${l.text}`);
      orch.stop();
      return 0;
    }
    default:
      console.error("commands: discover | status | import <html...> | chat <text> | memory");
      return cmd ? 2 : 0;
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
