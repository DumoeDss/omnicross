/**
 * auditRedact — the pure secret-redaction pass for captured audit bodies
 * (request-audit-log, design D3/D7).
 *
 * Body capture is opt-in and inherently sensitive: a prompt or tool argument can
 * embed a secret. {@link redactAuditText} is run over EVERY captured body (and
 * any other free text stored in a record) BEFORE it is persisted — defense in
 * depth on top of "request headers are NEVER captured" (so an Authorization /
 * x-api-key HEADER value never enters a record in the first place).
 *
 * It masks the obvious, high-confidence secret shapes ONLY (frozen list) — never
 * a broad heuristic that would gut a legitimate prompt:
 *  - `sk-…` API keys (covers `sk-ant-…`, `sk-omnicross-…`, `sk-proj-…`, OpenAI).
 *  - `Bearer <token>` authorization values.
 *  - `x-api-key` / `api-key` / `authorization` values written inline as text.
 *  - Google `AIza…` API keys.
 *
 * Pure + allocation-light + never throws.
 *
 * @module @omnicross/core/outbound-api/auditRedact
 */

/** The sentinel a masked secret is replaced with. */
export const AUDIT_REDACTED = '***REDACTED***';

/**
 * Ordered redaction rules. Each replaces the SECRET portion of a match with the
 * sentinel while keeping any leading label (so `x-api-key: ***REDACTED***`
 * stays readable). Applied in sequence; conservative by design.
 */
const RULES: ReadonlyArray<{ re: RegExp; replace: string }> = [
  // `sk-…` family (Anthropic sk-ant-, omnicross sk-omnicross-, OpenAI sk-proj-/sk-).
  { re: /\bsk-[A-Za-z0-9_-]{6,}/g, replace: AUDIT_REDACTED },
  // Google API keys.
  { re: /\bAIza[A-Za-z0-9_-]{10,}/g, replace: AUDIT_REDACTED },
  // `Bearer <token>` (auth headers echoed into a body / SSE error).
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, replace: `Bearer ${AUDIT_REDACTED}` },
  // Inline `x-api-key` / `api-key` / `authorization` label followed by a value.
  {
    re: /\b(x-api-key|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi,
    replace: `$1$2${AUDIT_REDACTED}`,
  },
  // `x-goog-api-key` header echoed inline.
  {
    re: /\b(x-goog-api-key)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi,
    replace: `$1$2${AUDIT_REDACTED}`,
  },
];

/**
 * Mask obvious secrets in `text`. Pure; returns the input unchanged when it holds
 * no recognized secret shape. Never throws (a bad input returns `''`).
 */
export function redactAuditText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let out = text;
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace);
  }
  return out;
}
