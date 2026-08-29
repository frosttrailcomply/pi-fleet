// Loads persisted fleet environment written by scripts/setup-browser-search.mjs
// (~/.pi/agent/fleet/camofox.env) so the keyless discovery credentials are
// available at runtime without the user exporting anything. Shell-provided
// values always win; this only fills what is unset.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Populate CAMOFOX_API_KEY / BROWSER_SEARCH_DIR from the persisted env file if unset. */
export function loadFleetEnv(stateDir?: string): void {
  const dir = stateDir || process.env.PI_FLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet");
  const file = join(dir, "camofox.env");
  if (!existsSync(file)) return;
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
    }
  } catch {
    /* best-effort */
  }
}
