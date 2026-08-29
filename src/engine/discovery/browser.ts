// Keyless live Censys discovery via an external, browser-capable fetcher.
//
// Censys' web UI sits behind Cloudflare and a login wall, so a plain HTTP GET
// returns a challenge page, not results. This adapter shells out to a
// configurable command that renders the page in a real/stealth browser and
// returns its HTML — by default browser-search's `smart-extract.mjs`
// (CloakBrowser-backed), but any equivalent (Firecrawl, a saved-HTML dumper)
// works. The returned HTML is parsed with the same extractor used for saved
// pages, so no Censys API key is ever needed.

import { spawn } from "node:child_process";
import type { BrowserScrapeConfig } from "../types.ts";
import { extractFromHtml, type HostPort } from "./censys.ts";

/** Expand ${VAR} / $VAR against the environment; leave unknown vars empty. */
export function expandEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (_m, a, b) => process.env[a ?? b] ?? "");
}

/** Read a dot-path (e.g. "results.0.content") out of a parsed JSON value. */
export function readPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Default runner: spawn the command, capture stdout/stderr, enforce a timeout. */
export const spawnRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });

export interface BrowserScrapeDeps {
  run?: CommandRunner;
}

/**
 * Fetch the Censys search page for `query` through the configured browser
 * command and extract host:port candidates. Returns [] on any failure so the
 * caller can fall back to other discovery sources.
 */
export async function scrapeCensysViaBrowser(
  cfg: BrowserScrapeConfig,
  query: string,
  deps: BrowserScrapeDeps = {},
): Promise<HostPort[]> {
  if (!cfg.enabled || cfg.command.length === 0) return [];
  const run = deps.run ?? spawnRunner;
  const url = cfg.searchUrl.replace("{query}", encodeURIComponent(query));
  const [rawCmd, ...rawArgs] = cfg.command;
  const cmd = expandEnv(rawCmd!);
  const args = rawArgs.map((a) => expandEnv(a.replace("{url}", url)));

  let res: RunResult;
  try {
    res = await run(cmd, args, cfg.timeoutMs);
  } catch {
    return [];
  }
  if (res.code !== 0 && !res.stdout.trim()) return [];

  // stdout is either raw HTML or JSON containing the HTML at resultPath.
  let html = res.stdout;
  if (cfg.resultPath) {
    try {
      const parsed = JSON.parse(res.stdout);
      const val = readPath(parsed, cfg.resultPath);
      if (typeof val === "string") html = val;
    } catch {
      // Not JSON — fall back to treating stdout as raw HTML.
    }
  }
  return extractFromHtml(html);
}
