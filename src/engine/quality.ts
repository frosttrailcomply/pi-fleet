// Answer-quality guards shared by the failover executor and MoA. Public scraped
// endpoints are frequently honeypots / mislabeled proxies that return canned
// filler and parrot the prompt back; these heuristics reject such answers so a
// live-but-useless endpoint is treated as a failure and routed around.

/** True if the aggregator echoed the MoA aggregation scaffolding instead of answering. */
export function echoesScaffolding(text: string): boolean {
  return /###\s*Candidate\s+\d|Produce the single best final answer|Original user query:|Candidate responses:/i.test(text);
}

/**
 * True if a model's answer is unusable: empty, or "text" with no real words
 * (e.g. a stray number like "-232", punctuation, or a lone token).
 */
export function isDegenerate(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length === 0) return true;
  const letters = (t.match(/[A-Za-zÀ-ɏЀ-ӿ一-鿿]/g) ?? []).length;
  if (t.length <= 8 && letters < 2) return true;
  return false;
}

/**
 * True if an answer just parrots the user's prompt back (honeypot/echo proxies
 * repeat the prompt, often several times) rather than answering it.
 */
export function echoesPrompt(answer: string, userText: string): boolean {
  const u = (userText ?? "").trim().toLowerCase();
  const a = (answer ?? "").toLowerCase();
  if (u.length < 20) return false;
  const key = u.slice(0, 40);
  let idx = a.indexOf(key), count = 0;
  while (idx !== -1) { count++; idx = a.indexOf(key, idx + key.length); }
  if (count >= 2) return true;
  if (a.includes(u) && u.length > a.length * 0.5) return true;
  // Honeypot signature: quotes a prefix/substring of the prompt back
  // (e.g. `Regarding "You are professional OSINTer.", ...`).
  for (const m of a.matchAll(/["“'']([^"“”'']{15,})["”'']/g)) {
    const span = m[1]!.trim();
    if (span.length >= 15 && u.includes(span)) return true;
  }
  return false;
}

// Canned filler templates emitted by honeypot/echo endpoints regardless of the
// question. Matching two or more is a strong signal of a non-answer.
const FILLER_PATTERNS = [
  /I'll do my best to assist/i,
  /I've seen similar requests before/i,
  /Is there anything else I can help/i,
  /approaching this step by step/i,
  /Great question! Let me explain/i,
  /Let me think about this carefully/i,
  /Feel free to ask if you need/i,
  /Would you like me to go into more detail/i,
  /Here's what I can tell you:/i,
  /I'd be happy to help/i,
  /I hope that helps! Let me know if you have follow-up/i,
  /can offer some guidance/i,
];

/** True if the answer is generic canned filler (>=2 template phrases). */
export function isFiller(answer: string): boolean {
  const a = answer ?? "";
  let hits = 0;
  for (const re of FILLER_PATTERNS) if (re.test(a)) { hits++; if (hits >= 2) return true; }
  return false;
}

/** Combined check: is this answer unusable for the given prompt? */
export function isBadAnswer(answer: string, userText: string): boolean {
  return isDegenerate(answer) || echoesScaffolding(answer) || echoesPrompt(answer, userText) || isFiller(answer);
}
