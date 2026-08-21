/**
 * auditSessionKey — derive a stable CONVERSATION-session key for the audit
 * store (audit-store-sharding, design D1).
 *
 * The audit body store shards by session and delta-encodes each turn against the
 * previous one, so it needs an identifier that is STABLE across the turns of one
 * conversation and DISTINCT between concurrent conversations. Probe order:
 *
 *  1. Anthropic `metadata.user_id` — Claude Code embeds `..._session_<uuid>` there
 *     and nothing else in the codebase reads it. Only the `_session_` segment is
 *     used; a bare per-USER id would collapse every conversation of one user into
 *     a single shard and destroy the delta chain.
 *  2. {@link deriveGatewaySessionKey} — the existing gateway-affinity derivation
 *     (session-id / thread-id headers, body `session_id` / `thread_id` /
 *     `conversation_id` / `prompt_cache_key`, Responses content fingerprint).
 *     Reused verbatim and deliberately NOT modified: account-affinity routing
 *     depends on it, and audit must not perturb routing behaviour.
 *  3. An Anthropic-shaped content fingerprint (system text + first user message),
 *     which the Responses-shaped fingerprint in step 2 does not cover.
 *  4. The caller's route-scoped fallback seed (step 2's own last resort).
 *
 * SECRET-FREE: every branch returns a TRUNCATED SHA-256 digest — never a raw id,
 * prompt, or key. The digest is lowercase hex, which is also what makes it safe to
 * use directly as a shard file name.
 *
 * Pure module — no I/O, never throws.
 *
 * @module @omnicross/core/outbound-api/auditSessionKey
 */

import { createHash } from 'node:crypto';

import {
  deriveGatewaySessionKey,
  flattenMatchText,
  MATCH_TEXT_PER_MESSAGE_CAP,
  type SessionKeySource,
  type SessionRequestHeaders,
} from '../provider-proxy/matchText';

/**
 * Gateway sources that carry an EXPLICIT client-supplied conversation id. Only
 * these outrank the Anthropic content fingerprint below; the gateway's own
 * fingerprint is Responses-shaped (`instructions` / `input`) and, on an Anthropic
 * body, degrades to the system prompt ALONE — which would collide every
 * conversation sharing a system prompt into a single shard.
 */
const EXPLICIT_ID_SOURCES: ReadonlySet<SessionKeySource> = new Set([
  'session-header',
  'thread-header',
  'body-session-id',
  'body-thread-id',
  'prompt-cache-key',
]);

/** Matches the `_session_<id>` segment Claude Code appends to `metadata.user_id`. */
const ANTHROPIC_SESSION_RE = /_session_([A-Za-z0-9][A-Za-z0-9_-]{7,})/;

/** Digest length (hex chars). Matches `deriveGatewaySessionKey` so both look alike. */
const DIGEST_HEX = 32;

/** Collision-resistant, bounded, secret-free identifier. */
function stableDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, DIGEST_HEX);
}

/** A plain object, or `null` for anything else (arrays included). */
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The conversation id embedded in Anthropic's `metadata.user_id`, or `undefined`.
 * Only the `_session_` segment counts — see the module note.
 */
function anthropicSessionId(body: Record<string, unknown>): string | undefined {
  const userId = asObject(body['metadata'])?.['user_id'];
  if (typeof userId !== 'string' || !userId) return undefined;
  const matched = ANTHROPIC_SESSION_RE.exec(userId);
  return matched?.[1];
}

/**
 * A stable fingerprint of an Anthropic `messages` request: the system prompt plus
 * the FIRST user message. Both are fixed for the lifetime of a conversation while
 * later turns keep appending, so the fingerprint holds across turns.
 */
function anthropicContentFingerprint(body: Record<string, unknown>): string | undefined {
  const messages = body['messages'];
  // Require a real `messages` array. A body carrying `system` alongside `input`
  // is an OpenAI-compatible shape that the gateway fingerprint reads better.
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  const parts: string[] = [];
  const system = flattenMatchText(body['system']).trim();
  if (system) parts.push(system.slice(0, MATCH_TEXT_PER_MESSAGE_CAP));

  let firstUser = '';
  for (const entry of messages) {
    const message = asObject(entry);
    if (!message || message['role'] !== 'user') continue;
    const text = flattenMatchText(message['content']).trim();
    if (!text) continue;
    firstUser = text.slice(0, MATCH_TEXT_PER_MESSAGE_CAP);
    break;
  }

  if (parts.length === 0 && !firstUser) return undefined;
  return `${parts.join('\u0000')}\u0000${firstUser}`;
}

/** Options for {@link deriveAuditSessionKey}. */
export interface AuditSessionKeyOptions {
  /** Route-scoped seed used when the request carries no usable conversation id. */
  readonly fallbackKey?: string;
  /** Ingress endpoint, namespacing the conservative fallback. */
  readonly endpoint?: string;
}

/**
 * Derive the audit shard key for one request. ALWAYS returns a lowercase-hex
 * digest (never empty), so the caller never has to handle a missing key.
 */
export function deriveAuditSessionKey(
  body: Record<string, unknown>,
  headers: SessionRequestHeaders = {},
  options: AuditSessionKeyOptions = {},
): string {
  const anthropicSession = anthropicSessionId(body);
  if (anthropicSession) return stableDigest(`anthropic-session\u0000${anthropicSession}`);

  // The gateway derivation covers every explicit id the Codex/Responses and
  // OpenAI-compatible clients send. Those outrank any fingerprint.
  const gateway = deriveGatewaySessionKey(body, headers, {
    ...(options.fallbackKey !== undefined ? { fallbackKey: options.fallbackKey } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
  });
  if (EXPLICIT_ID_SOURCES.has(gateway.source)) return gateway.key;

  // No explicit id: fingerprint an Anthropic body ourselves. The gateway
  // fingerprint never reads `messages` and would merge distinct conversations.
  const fingerprint = anthropicContentFingerprint(body);
  if (fingerprint) return stableDigest(`anthropic-content\u0000${fingerprint}`);

  // Otherwise the gateway's own fingerprint (Responses shapes) or, last, its
  // route-scoped fallback.
  return gateway.key;
}
