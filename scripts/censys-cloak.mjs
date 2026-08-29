#!/usr/bin/env node
// Proxy-capable Censys scraper: drives browser-search's CloakBrowser
// (cloak-fetch), which launches a fresh Playwright/camoufox browser *through*
// the given proxy (unlike the shared Camofox container, which ignores
// per-request proxies). Used by the discovery refresher when proxy rotation is
// enabled; the validated proxy is passed in CENSYS_PROXY.
//
// Prints the rendered HTML on stdout for the same extractor used elsewhere.
//
// Usage: node censys-cloak.mjs "<censys search url>"    (CENSYS_PROXY optional)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const URL = process.argv[2];
if (!URL) { process.stderr.write("usage: censys-cloak.mjs <url>\n"); process.exit(2); }

const BS_DIR = process.env.BROWSER_SEARCH_DIR || "";
const PROXY = process.env.CENSYS_PROXY || "";
const WAIT = process.env.CENSYS_SCRAPE_WAIT_MS || "15000";
const cloak = BS_DIR ? join(BS_DIR, "scripts", "cloak", "cloak-fetch.mjs") : "";

if (!cloak || !existsSync(cloak)) {
  process.stderr.write(`[censys-cloak] cloak-fetch not found (set BROWSER_SEARCH_DIR)\n`);
  process.exit(1);
}

const args = [cloak, URL, "--format", "html", "--wait", WAIT];
if (PROXY) args.push("--proxy", PROXY, "--geoip", "--webrtc-auto");

const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.on("error", (e) => { process.stderr.write(`[censys-cloak] ${e.message}\n`); process.exit(1); });
child.on("close", (code) => {
  process.stderr.write(`[censys-cloak] proxy=${PROXY || "none"} bytes=${out.length} ${err.split("\n").pop() || ""}\n`);
  process.stdout.write(out);
  process.exit(code === 0 || out.length > 0 ? 0 : 1);
});
