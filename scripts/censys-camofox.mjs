#!/usr/bin/env node
// Keyless Censys scraper driving the browser-search Camofox (camoufox) service.
//
// Renders the Censys search page in the stealth browser, waits for the result
// anchors to appear (they load via XHR after readyState), then prints the full
// rendered HTML on stdout. pi-fleet's browser adapter feeds that HTML to the
// same extractor used for saved pages, yielding host:port with no Censys key.
//
// Requires the browser-search Camofox container running (default :9377) and
// CAMOFOX_API_KEY set to match it. See scripts/setup-browser-search.mjs.
//
// Usage: node censys-camofox.mjs "<censys search url>"

const URL = process.argv[2];
if (!URL) { process.stderr.write("usage: censys-camofox.mjs <url>\n"); process.exit(2); }

const BASE = (process.env.CAMOFOX_URL || "http://127.0.0.1:9377").replace(/\/$/, "");
const API_KEY = process.env.CAMOFOX_API_KEY || "";
const USER_ID = process.env.CAMOFOX_USER_ID || "pi-fleet-bot";
const SESSION_KEY = process.env.CAMOFOX_SESSION_KEY || "default";
const WAIT_MS = Number(process.env.CENSYS_SCRAPE_WAIT_MS || 25000); // max time to wait for results
const POLL_MS = 1500;

async function call(method, path, body, bearer = false) {
  const headers = { "content-type": "application/json" };
  if (bearer && API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const ANCHOR_COUNT = `document.querySelectorAll('a[href*="/hosts/"],a[href*="/web/"]').length`;
const OUTER_HTML = `document.documentElement.outerHTML`;

async function main() {
  let tabId;
  try {
    const tab = await call("POST", "/tabs", { userId: USER_ID, sessionKey: SESSION_KEY, url: URL }, true);
    tabId = tab.tabId || tab.id;
    if (!tabId) throw new Error("no tabId in response");

    // Poll until result anchors render (or timeout), then grab the HTML.
    const deadline = Date.now() + WAIT_MS;
    let count = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const ev = await call("POST", `/tabs/${tabId}/evaluate`, { userId: USER_ID, expression: ANCHOR_COUNT });
        count = Number(ev.result ?? 0);
        if (count > 0) break;
      } catch { /* keep polling */ }
    }
    const html = await call("POST", `/tabs/${tabId}/evaluate`, { userId: USER_ID, expression: OUTER_HTML });
    process.stderr.write(`[censys-camofox] anchors=${count}, html=${String(html.result ?? "").length} bytes\n`);
    process.stdout.write(String(html.result ?? ""));
  } finally {
    if (tabId) await call("DELETE", `/tabs/${tabId}`, { userId: USER_ID }).catch(() => {});
  }
}

main().catch((e) => { process.stderr.write(`[censys-camofox] ${e.message}\n`); process.exit(1); });
