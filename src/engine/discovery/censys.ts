// Censys discovery: two ingestion paths that both yield canonical `host:port`.
//
//  1. Saved-HTML import  — a faithful TS port of legacy/extract_ollama_hosts.py.
//     Kept as a credential-free fallback so a user can drop a saved Censys
//     results page in and refresh the fleet from it.
//  2. Censys Platform API — preferred when CENSYS_API_ID/SECRET are present.
//
// Neither path contacts a discovered host; they only produce candidate targets
// for the probe stage to verify.

import { readFileSync, existsSync } from "node:fs";

const DEFAULT_PORT = 11434;

// "View <ip>[:port] Details" titles (both Censys page layouts).
const TITLE_RE = /title="View\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?\s+Details"/g;
// Detail URLs: .../(hosts|web)/<ip>[:port]?at_time=...
const URL_RE = /platform\.censys\.io\/(?:hosts|web)\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d+))?/g;

export interface HostPort {
  host: string;
  port: number;
}

function validIp(ip: string): boolean {
  const parts = ip.split(".");
  return parts.length === 4 && parts.every((p) => { const n = Number(p); return Number.isInteger(n) && n >= 0 && n <= 255; });
}

function sortKey(a: HostPort): number[] {
  return [...a.host.split(".").map(Number), a.port];
}

function cmp(a: HostPort, b: HostPort): number {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Extract unique host:port pairs from saved Censys HTML text. */
export function extractFromHtml(text: string): HostPort[] {
  const found = new Map<string, HostPort>();
  const add = (ip: string, port?: string) => {
    if (!validIp(ip)) return;
    const p = port ? Number(port) : DEFAULT_PORT;
    found.set(`${ip}:${p}`, { host: ip, port: p });
  };
  for (const m of text.matchAll(TITLE_RE)) add(m[1]!, m[2]);
  for (const m of text.matchAll(URL_RE)) add(m[1]!, m[2]);
  return [...found.values()].sort(cmp);
}

/** Extract from one or more saved-HTML files, deduped and sorted. */
export function extractFromFiles(paths: string[]): HostPort[] {
  const found = new Map<string, HostPort>();
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const hp of extractFromHtml(readFileSync(path, "utf8"))) {
      found.set(`${hp.host}:${hp.port}`, hp);
    }
  }
  return [...found.values()].sort(cmp);
}

export interface CensysCreds {
  id: string;
  secret: string;
}

/** Resolve Censys creds from configured env var names, if present. */
export function censysCredsFromEnv(idEnv: string, secretEnv: string): CensysCreds | null {
  const id = process.env[idEnv];
  const secret = process.env[secretEnv];
  return id && secret ? { id, secret } : null;
}

/**
 * Query the Censys Platform search API for the ollama intent and return
 * candidate host:port pairs. Paginates until exhausted or `maxPages` reached.
 * Returns [] on any auth/network error (the HTML import path remains available).
 */
export async function queryCensys(
  query: string,
  creds: CensysCreds,
  opts: { maxPages?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<HostPort[]> {
  const maxPages = opts.maxPages ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = "Basic " + Buffer.from(`${creds.id}:${creds.secret}`).toString("base64");
  const found = new Map<string, HostPort>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://search.censys.io/api/v2/hosts/search");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    let body: CensysSearchResponse;
    try {
      const res = await doFetch(url, { headers: { Authorization: auth, Accept: "application/json" }, signal: opts.signal });
      if (!res.ok) break;
      body = (await res.json()) as CensysSearchResponse;
    } catch {
      break;
    }
    for (const hit of body.result?.hits ?? []) {
      const ip = hit.ip;
      if (!ip || !validIp(ip)) continue;
      const ports = (hit.services ?? []).map((s) => s.port).filter((p): p is number => typeof p === "number");
      const list = ports.length ? ports : [DEFAULT_PORT];
      for (const port of list) found.set(`${ip}:${port}`, { host: ip, port });
    }
    cursor = body.result?.links?.next || undefined;
    if (!cursor) break;
  }
  return [...found.values()].sort(cmp);
}

interface CensysSearchResponse {
  result?: {
    hits?: Array<{ ip?: string; services?: Array<{ port?: number }> }>;
    links?: { next?: string };
  };
}
