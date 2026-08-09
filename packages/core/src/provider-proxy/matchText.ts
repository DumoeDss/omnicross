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

import { createHash } from 'node:crypto';

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
 * `user`/`system` messages, each truncated to a per-message char cap so matching
 * cost is independent of conversation length. Assistant turns are excluded to
 * keep routing based on instructions rather than generated text. System prompt
 * is emitted first.
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

/**
 * Derive a STABLE per-conversation session key for the account-pool's session
 * affinity (subscription-account-scheduling, D5). Anchored on `system` + the
 * FIRST `user` message — both survive a multi-turn conversation UNCHANGED (unlike
 * the full transcript, which grows every turn), so one conversation keeps one
 * session key and thus one sticky account. Returns `undefined` when there is no
 * anchor text (⇒ the selector falls back to pure priority/LRU, still correct).
 *
 * Lives here (the shared match-text SSOT) so BOTH relay paths — the core
 * `/v1/messages` ingress and the daemon `SubscriptionDispatcher` — derive the
 * SAME key for the same body.
 */
export function deriveSubscriptionSessionKey(
  anthropicBody: Record<string, unknown>,
): string | undefined {
  const system = flattenMatchText(anthropicBody.system).trim().slice(0, MATCH_TEXT_PER_MESSAGE_CAP);
  const messages = Array.isArray(anthropicBody.messages) ? anthropicBody.messages : [];
  let firstUser = '';
  for (const message of messages) {
    if (message && typeof message === 'object' && (message as Record<string, unknown>).role === 'user') {
      firstUser = flattenMatchText((message as Record<string, unknown>).content)
        .trim()
        .slice(0, MATCH_TEXT_PER_MESSAGE_CAP);
      break;
    }
  }
  const anchor = `${system}\u0000${firstUser}`;
  if (!system && !firstUser) return undefined;
  return fnv1a(anchor);
}

/**
 * Source used to derive a gateway session-affinity key. The value is kept
 * deliberately small and non-sensitive: callers only receive the hashed key,
 * while the source is useful to tests/diagnostics without exposing the raw
 * session id.
 */
export type SessionKeySource =
  | 'session-header'
  | 'thread-header'
  | 'body-session-id'
  | 'body-thread-id'
  | 'prompt-cache-key'
  | 'content-fingerprint'
  | 'api-key-fallback';

/** A hashed session key and the extraction path that produced it. */
export interface DerivedSessionKey {
  readonly key: string;
  readonly source: SessionKeySource;
}

/** Options for {@link deriveGatewaySessionKey}. */
export interface GatewaySessionKeyOptions {
  /** A stable route/key seed used when the request has no conversation id. */
  readonly fallbackKey?: string;
  /** Namespaces the conservative fallback (normally `responses`). */
  readonly endpoint?: string;
}

/** Header bag accepted by Node's IncomingHttpHeaders and browser-style tests. */
export type SessionRequestHeaders = Record<string, string | string[] | undefined>;

/** Maximum amount of an explicit id that participates in a hash. */
const SESSION_ID_CAP = 1024;

/**
 * Derive one stable account-pool affinity key for a gateway request.
 *
 * Codex/Responses sends the same conversation id in a few wire-compatible
 * locations depending on the client version. Prefer those explicit ids in a
 * deterministic order, then fall back to a bounded content fingerprint made
 * from stable developer/system instructions and the first user input. The
 * final fallback is route-scoped (api key/session + endpoint) so a request
 * with no usable metadata remains conservative and does not rotate accounts
 * on every turn. Raw ids and prompts are never returned or logged; only their
 * truncated SHA-256 digest is exposed as `key`.
 */
export function deriveGatewaySessionKey(
  body: Record<string, unknown>,
  headers: SessionRequestHeaders = {},
  options: GatewaySessionKeyOptions = {},
): DerivedSessionKey {
  // Codex's header spellings are intentionally checked case-insensitively. A
  // duplicate header (Node's string[]) is accepted by taking its first
  // non-empty value, matching normal HTTP header semantics.
  const sessionHeader = firstHeaderValue(headers, ['session-id', 'session_id', 'x-session-id']);
  if (sessionHeader) {
    return { key: stableSessionDigest(sessionHeader), source: 'session-header' };
  }

  // Codex versions that do not emit `session-id` still carry the persistent
  // conversation identity as `thread-id`. Keep it below the canonical session
  // id, but above body metadata and the prompt cache key.
  const threadHeader = firstHeaderValue(headers, ['thread-id', 'thread_id', 'x-thread-id']);
  if (threadHeader) {
    return { key: stableSessionDigest(threadHeader), source: 'thread-header' };
  }

  const bodySessionId = scalarSessionValue(body.session_id);
  if (bodySessionId) {
    return { key: stableSessionDigest(bodySessionId), source: 'body-session-id' };
  }

  const bodyThreadId = scalarSessionValue(body.thread_id ?? body.threadId);
  if (bodyThreadId) {
    return { key: stableSessionDigest(bodyThreadId), source: 'body-thread-id' };
  }

  const conversationId = scalarSessionValue(body.conversation_id);
  if (conversationId) {
    return { key: stableSessionDigest(conversationId), source: 'body-session-id' };
  }

  const promptCacheKey = scalarSessionValue(body.prompt_cache_key);
  if (promptCacheKey) {
    return { key: stableSessionDigest(promptCacheKey), source: 'prompt-cache-key' };
  }

  const fingerprint = deriveResponsesContentFingerprint(body);
  if (fingerprint) {
    return { key: stableSessionDigest(fingerprint), source: 'content-fingerprint' };
  }

  // The fallback is deliberately stable for the route/key, but never a raw
  // identifier. If an embedder has no route seed at all we still use a
  // protocol namespace; this pins an otherwise anonymous ingress instead of
  // silently reintroducing per-request LRU rotation.
  const endpoint = options.endpoint?.trim() || 'responses';
  const fallback = options.fallbackKey?.trim() || 'anonymous';
  return {
    key: stableSessionDigest(`${endpoint}\u0000${fallback}`),
    source: 'api-key-fallback',
  };
}

/**
 * Collision-resistant, bounded identifier for gateway affinity and cache keys.
 * Truncating SHA-256 to 128 bits keeps generated prompt-cache keys compact while
 * avoiding disclosure of raw session ids or prompt fingerprints.
 */
function stableSessionDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

/** Return the first non-empty value for a case-insensitive header name list. */
function firstHeaderValue(
  headers: SessionRequestHeaders,
  names: readonly string[],
): string | undefined {
  const byLower = new Map<string, string | string[]>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' || Array.isArray(value)) {
      // Preserve the first spelling when a test/browser supplies duplicate
      // case variants; Node normally folds these before they reach us.
      const lower = name.toLowerCase();
      if (!byLower.has(lower)) byLower.set(lower, value);
    }
  }
  for (const name of names) {
    const value = byLower.get(name);
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed.slice(0, SESSION_ID_CAP);
    }
  }
  return undefined;
}

/** Accept only scalar body ids; objects/arrays are not stable identifiers. */
function scalarSessionValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, SESSION_ID_CAP) : undefined;
}

/**
 * Build a bounded Responses content anchor. `instructions` is the Responses
 * equivalent of a top-level system prompt. Input items with developer/system
 * roles are all stable instructions; only the first user item participates so
 * subsequent turns do not move a conversation to another account.
 */
function deriveResponsesContentFingerprint(body: Record<string, unknown>): string | undefined {
  const stable: string[] = [];
  const instructions = flattenMatchText(body.instructions).trim();
  if (instructions) stable.push(instructions.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));

  const input = body.input;
  let firstUser = '';
  const visitItem = (item: unknown): void => {
    if (typeof item === 'string') {
      if (!firstUser) firstUser = item.trim().slice(0, MATCH_TEXT_PER_MESSAGE_CAP);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
    const content = record.content ?? record.text ?? record.input;
    const text = flattenMatchText(content !== undefined ? content : record).trim();
    if (!text) return;
    if (role === 'developer' || role === 'system') {
      stable.push(text.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));
    } else if (role === 'user' || !role) {
      if (!firstUser) firstUser = text.slice(0, MATCH_TEXT_PER_MESSAGE_CAP);
    }
  };

  if (Array.isArray(input)) {
    for (const item of input) visitItem(item);
  } else if (input !== undefined) {
    visitItem(input);
  }

  // Some OpenAI-compatible clients still send `system` alongside `input`.
  // Treat it as stable content without changing the normal Responses path.
  if (stable.length === 0) {
    const legacySystem = flattenMatchText(body.system).trim();
    if (legacySystem) stable.push(legacySystem.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));
  }

  if (stable.length === 0 && !firstUser) return undefined;
  return `${stable.join('\u0000')}\u0000${firstUser}`;
}

/** Small stable hash retained for the legacy Anthropic affinity key. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
