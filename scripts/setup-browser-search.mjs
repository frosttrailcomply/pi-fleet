#!/usr/bin/env node
// One-shot installer for the browser-search stack that powers pi-fleet's
// keyless Censys discovery. Runs automatically from `postinstall`, so installing
// the extension installs the whole stack — no separate manual step.
//
// Full run (default): clone browser-search, npm install it, generate/reuse a
// CAMOFOX_API_KEY, and pull + start the Camofox (camoufox) container. All state
// lives under ~/.pi/agent/fleet/ so the extension and CLI can find it at runtime
// regardless of the shell environment.
//
//   node scripts/setup-browser-search.mjs               # full (default)
//   node scripts/setup-browser-search.mjs --code-only   # clone + npm install only
//   node scripts/setup-browser-search.mjs --start-only   # just (re)start the container
//
// Never hard-fails a parent `npm install`: missing git/docker/network degrade to
// a warning and a printed next step.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const FLEET_DIR = process.env.PI_FLEET_STATE_DIR || join(homedir(), ".pi", "agent", "fleet");
const CLONE_DIR = process.env.BROWSER_SEARCH_DIR || join(FLEET_DIR, "browser-search");
const ENV_FILE = join(FLEET_DIR, "camofox.env");           // stable, machine-readable (KEY=VALUE)
const REPO = "https://github.com/Johell1NS/browser-search";
const IMAGE = "ghcr.io/jo-inc/camofox-browser:latest";

const args = new Set(process.argv.slice(2));
const codeOnly = args.has("--code-only");
const startOnly = args.has("--start-only");
const isPostinstall = process.env.npm_lifecycle_event === "postinstall";

if (isPostinstall && (process.env.CI || process.env.PI_FLEET_SKIP_SETUP)) {
  console.log("[setup] postinstall skipped (CI or PI_FLEET_SKIP_SETUP)");
  process.exit(0);
}

const IS_WIN = process.platform === "win32";
// On Windows, npm is a shim (npm.cmd); execFile won't find bare "npm", and .cmd
// needs a shell. Run npm through the shell there.
const NPM = IS_WIN ? "npm.cmd" : "npm";

function run(cmd, cmdArgs, opts = {}) { return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts }); }
function runShell(line, opts = {}) { return execFileSync(line, { stdio: "inherit", shell: true, ...opts }); }
function out(cmd, cmdArgs) { return execFileSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
function has(cmd) {
  try {
    if (IS_WIN) execFileSync(`${cmd} --version`, { stdio: "ignore", shell: true });
    else execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
function engine() { return has("podman") ? "podman" : has("docker") ? "docker" : null; }

function npmInstall(cwd) {
  console.log("[setup] npm install (browser-search)");
  if (IS_WIN) runShell(`${NPM} install`, { cwd });
  else run(NPM, ["install"], { cwd });
}

function cloneAndInstall() {
  if (existsSync(join(CLONE_DIR, "package.json"))) {
    console.log(`[setup] browser-search present at ${CLONE_DIR}`);
  } else {
    if (!has("git")) throw new Error("git not found — cannot install browser-search");
    mkdirSync(CLONE_DIR, { recursive: true });
    console.log(`[setup] cloning browser-search -> ${CLONE_DIR}`);
    run("git", ["clone", "--depth", "1", REPO, CLONE_DIR]);
  }
  // The container + key are what discovery needs at runtime (our scraper talks
  // to Camofox over HTTP), so a failed clone-install must not abort setup.
  try {
    npmInstall(CLONE_DIR);
  } catch (e) {
    console.error(`[setup] browser-search 'npm install' skipped: ${e.message}`);
  }
}

function ensureKey() {
  mkdirSync(FLEET_DIR, { recursive: true });
  let key = process.env.CAMOFOX_API_KEY;
  const readKV = (file, re) => { try { const m = readFileSync(file, "utf8").match(re); return m ? m[1].trim() : null; } catch { return null; } };
  if (!key) key = readKV(ENV_FILE, /CAMOFOX_API_KEY=(.+)/);
  if (!key) key = readKV(join(CLONE_DIR, ".env"), /CAMOFOX_API_KEY=(.+)/);
  if (!key) key = randomBytes(16).toString("hex");
  // Persist to both the stable env file (read by the extension) and the clone's .env (used by --env-file).
  writeFileSync(ENV_FILE, `CAMOFOX_API_KEY=${key}\nBROWSER_SEARCH_DIR=${CLONE_DIR}\n`);
  try { mkdirSync(CLONE_DIR, { recursive: true }); writeFileSync(join(CLONE_DIR, ".env"), `CAMOFOX_API_KEY=${key}\n`); } catch { /* clone may not exist in start-only */ }
  return key;
}

function containerExists(eng) { try { return out(eng, ["ps", "-a", "--format", "{{.Names}}"]).split(/\r?\n/).includes("camofox-browser"); } catch { return false; } }
function containerRunning(eng) { try { return out(eng, ["ps", "--format", "{{.Names}}"]).split(/\r?\n/).includes("camofox-browser"); } catch { return false; } }

function startCamofox() {
  const eng = engine();
  if (!eng) { console.log("[setup] no podman/docker found — start Camofox manually (see README)"); return false; }
  if (containerRunning(eng)) { console.log("[setup] Camofox already running"); return true; }
  const envFile = existsSync(join(CLONE_DIR, ".env")) ? join(CLONE_DIR, ".env") : ENV_FILE;
  if (containerExists(eng)) {
    console.log(`[setup] starting existing Camofox container via ${eng}`);
    run(eng, ["start", "camofox-browser"]);
    return true;
  }
  console.log(`[setup] pulling + starting Camofox via ${eng} on 127.0.0.1:9377 (first run downloads the image)`);
  run(eng, [
    "run", "-d", "--name", "camofox-browser", "--restart", "unless-stopped",
    "--memory", "2g", "-p", "127.0.0.1:9377:9377", "--env-file", envFile, IMAGE,
  ]);
  return true;
}

try {
  if (startOnly) {
    ensureKey();
    startCamofox();
  } else {
    cloneAndInstall();
    ensureKey();
    if (!codeOnly) startCamofox();
  }
  console.log(`\n[setup] done. State in ${FLEET_DIR} (auto-loaded by the extension).`);
  if (codeOnly) console.log("[setup] container not started (code-only). Start it: npm run setup:browser-search");
} catch (e) {
  console.error(`[setup] ${e.message}`);
  console.error("[setup] keyless Censys discovery will be unavailable until the browser-search stack is installed.");
  // Never fail a parent npm install.
  process.exit(isPostinstall ? 0 : 1);
}
