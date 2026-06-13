/**
 * matchText — the SINGLE SOURCE OF TRUTH for the bounded text slice the
 * OpenCodeGo keyword matcher (`resolveOpenCodeGoScenario` in
 * `@omnicross/subscriptions`) scans off `SubscriptionRequestSummary.matchText`.
 *
 * Both summary builders MUST call this one function so the two ingress paths
 * (`/v1/messages` core path + `/v1/responses` dispatcher path) produce
 * BYTE-IDENTICAL `matchText` for the same body — equivalence BY CONSTRUCTION,
 * not by two flatteners that drift. (design.md §1 "identical bounds" invariant.)
 *
 * Litmus: this lives in `@omnicross/core`. The dispatcher in
 * `@omnicross/subscriptions` imports it (subscriptions → core is the allowed
 * direction; core imports NOTHING from subscriptions). Core only WRITES the
 * resulting `string[]`; the matcher (which reads it) stays in subscriptions.
 *
 * @module provider-proxy/matchText
 */

/** Per-message char cap for the bounded match-text slice (design.md §2). */
export const MATCH_TEXT_PER_MESSAGE_CAP = 8192;
/** Number of most-recent user/system messages scanned (design.md §2). */
export const MATCH_TEXT_RECENT_MESSAGES = 6;

/**
 * Flatten a string / Anthropic content value to its concatenated text. The
 * UNION of both prior builders' behaviors (the most-inclusive-correct
 * flattener):
 *  - a bare string → itself;
 *  - an array → recurse each element (nested arrays included) and join;
 *  - a `tool_result` block whose `content` is a string OR a nested array →
 *    flatten that `content` (so tool-blocker words inside a tool_result are
 *    seen on BOTH paths — the regression this fixes);
 *  - any other object exposing a string `.text` → that text.
 * No length cap here — the caller (`collectMatchText`) caps the result.
 */
export function flattenMatchText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = flattenMatchText(item);
      if (text) parts.push(text);
    }
    return parts.join('\n');
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // `tool_result` carries its payload under `content` (string or block array),
    // NOT `text` — flatten it so its words participate in keyword matching.
    if (obj.type === 'tool_result' && obj.content !== undefined) {
      return flattenMatchText(obj.content);
    }
    if (typeof obj.text === 'string') return obj.text;
  }
  return '';
}

/**
 * Build the BOUNDED match-text slice: the `system` prompt plus the most recent
 * `user`/`system` messages, each truncated to a per-message char cap (design.md
 * §2 — mirrors the reference `DetectScenario` role filter, bounded so matching
 * cost is independent of conversation length). Assistant turns are excluded (the
 * §3 common-denominator decision; same safe direction as the reference for the
 * background tool-blocker pre-scan). System prompt is emitted first.
 *
 * @param anthropicBody the parsed Anthropic Messages request body.
 */
export function collectMatchText(anthropicBody: Record<string, unknown>): string[] {
  const messages = Array.isArray(anthropicBody.messages) ? anthropicBody.messages : [];
  const slices: string[] = [];

  const sys = flattenMatchText(anthropicBody.system).trim();
  if (sys) slices.push(sys.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));

  const recent: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recent.length < MATCH_TEXT_RECENT_MESSAGES; i--) {
    const message = messages[i];
    if (!message || typeof message !== 'object') continue;
    const role = (message as Record<string, unknown>).role;
    if (role !== 'user' && role !== 'system') continue;
    const text = flattenMatchText((message as Record<string, unknown>).content).trim();
    if (text) recent.push(text.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));
  }
  // `recent` is newest-first; reverse to chronological for readability (order is
  // immaterial to substring matching).
  for (let i = recent.length - 1; i >= 0; i--) slices.push(recent[i]);

  return slices;
}
