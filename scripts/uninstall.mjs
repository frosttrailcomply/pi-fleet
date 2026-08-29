#!/usr/bin/env node
// Tear down the browser-search stack that pi-fleet installed: stop and remove
// the Camofox container, and delete the cloned stack and persisted credentials.
//
//   node scripts/uninstall.mjs             # remove container + clone + camofox.env
//   node scripts/uninstall.mjs --purge     # the above, plus the native memory DB
//
// The pi extension itself is removed separately with `pi remove <source>`.

import { rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const FLEET_DIR = process.env.PI_FLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet");
const CLONE_DIR = process.env.BROWSER_SEARCH_DIR || join(FLEET_DIR, "browser-search");
const purge = process.argv.includes("--purge");

function has(cmd) { try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; } }
function tryRun(cmd, args) { try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } }
function rm(path, label) { if (existsSync(path)) { try { rmSync(path, { recursive: true, force: true }); console.log(`[uninstall] removed ${label}`); } catch (e) { console.error(`[uninstall] could not remove ${label}: ${e.message}`); } } }

const eng = has("podman") ? "podman" : has("docker") ? "docker" : null;
if (eng) {
  if (tryRun(eng, ["rm", "-f", "camofox-browser"])) console.log(`[uninstall] removed Camofox container (${eng})`);
  else console.log("[uninstall] no Camofox container to remove");
} else {
  console.log("[uninstall] no podman/docker found; skipping container removal");
}

rm(CLONE_DIR, "browser-search clone");
rm(join(FLEET_DIR, "camofox.env"), "camofox.env");
if (purge) {
  rm(join(FLEET_DIR, "memory.sqlite"), "native memory DB");
  rm(join(FLEET_DIR, "memory.sqlite-wal"), "memory WAL");
  rm(join(FLEET_DIR, "memory.sqlite-shm"), "memory SHM");
}

console.log("[uninstall] done. Remove the extension itself with:  pi remove git:github.com/frosttrailcomply/pi-fleet");
