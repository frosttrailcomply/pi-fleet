#!/usr/bin/env node
// Install the browser-search stack (github.com/Johell1NS/browser-search) that
// powers pi-fleet's keyless Censys discovery, and optionally bring up its
// Camofox (camoufox) stealth-browser container.
//
// Modes:
//   node scripts/setup-browser-search.mjs               # clone + npm install + start Camofox
//   node scripts/setup-browser-search.mjs --code-only   # clone + npm install only (no container)
//
// Credentials: a CAMOFOX_API_KEY is generated (or reused from the env) and
// written to <clone>/.env; the container is started with it. Export the same
// key in the shell/session where pi/pi-fleet runs so the scraper can talk to it.
//
// Safe to re-run: skips work that is already done, and never hard-fails a parent
// `npm install` (postinstall calls it with --code-only and swallows errors).

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/Johell1NS/browser-search";
const CLONE_DIR = process.env.BROWSER_SEARCH_DIR || join(PKG_ROOT, ".browser-search");
const codeOnly = process.argv.includes("--code-only");
const isPostinstall = process.env.npm_lifecycle_event === "postinstall";

// During automated installs, stay out of the way: skip in CI or when opted out,
// and skip if the stack is already present. Never block the install.
if (isPostinstall && (process.env.CI || process.env.PI_FLEET_SKIP_SETUP)) {
  console.log("[setup] postinstall skipped (CI or PI_FLEET_SKIP_SETUP)");
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}
function has(cmd) {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function cloneAndInstall() {
  if (existsSync(join(CLONE_DIR, "package.json"))) {
    console.log(`[setup] browser-search present at ${CLONE_DIR}`);
  } else {
    if (!has("git")) throw new Error("git not found");
    mkdirSync(dirname(CLONE_DIR), { recursive: true });
    console.log(`[setup] cloning browser-search -> ${CLONE_DIR}`);
    run("git", ["clone", "--depth", "1", REPO, CLONE_DIR]);
  }
  console.log("[setup] npm install (browser-search)");
  run("npm", ["install"], { cwd: CLONE_DIR });
  return CLONE_DIR;
}

function ensureKey() {
  const envFile = join(CLONE_DIR, ".env");
  let key = process.env.CAMOFOX_API_KEY;
  if (!key && existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(/CAMOFOX_API_KEY=(.+)/);
    if (m) key = m[1].trim();
  }
  if (!key) key = randomBytes(16).toString("hex");
  writeFileSync(envFile, `CAMOFOX_API_KEY=${key}\n`);
  return key;
}

function startCamofox(key) {
  const engine = has("podman") ? "podman" : has("docker") ? "docker" : null;
  if (!engine) { console.log("[setup] no podman/docker found; start Camofox manually (see README)"); return; }
  const envFile = join(CLONE_DIR, ".env");
  try { run(engine, ["rm", "-f", "camofox-browser"], { stdio: "ignore" }); } catch { /* not running */ }
  console.log(`[setup] starting Camofox via ${engine} on 127.0.0.1:9377`);
  run(engine, [
    "run", "-d", "--name", "camofox-browser", "--restart", "unless-stopped",
    "--memory", "2g", "-p", "127.0.0.1:9377:9377", "--env-file", envFile,
    "ghcr.io/jo-inc/camofox-browser:latest",
  ]);
}

try {
  cloneAndInstall();
  const key = ensureKey();
  if (!codeOnly) startCamofox(key);
  console.log("\n[setup] done. Export these where pi-fleet runs:\n");
  console.log(`  export BROWSER_SEARCH_DIR=${CLONE_DIR}`);
  console.log(`  export CAMOFOX_API_KEY=${key}`);
  if (codeOnly) console.log("\n  Then start Camofox: node scripts/setup-browser-search.mjs   (or see README)");
} catch (e) {
  console.error(`[setup] ${e.message}`);
  // Never fail a parent npm install.
  if (process.env.npm_lifecycle_event === "postinstall") process.exit(0);
  process.exit(1);
}
