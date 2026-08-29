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

function redactEncryptedContentValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = redactEncryptedContentValue(item) || changed;
    return changed;
  }
  let changed = false;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'encrypted_content') {
      record[key] = AUDIT_REDACTED;
      changed = true;
    } else {
      changed = redactEncryptedContentValue(nested) || changed;
    }
  }
  return changed;
}

/** Structurally redact one complete JSON document or SSE `data:` payload. */
function redactJsonValue(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return redactEncryptedContentValue(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Redact complete SSE payloads structurally while retaining their surrounding
 * framing. Invalid or truncated payloads fall through to the conservative text
 * scanner below.
 */
function redactEncryptedContentSse(text: string): string {
  return text.replace(/^(\s*data:\s*)([^\r\n]*)(\r?)$/gm, (line, prefix: string, payload: string, cr: string) => {
    if (!payload || payload.trim() === '[DONE]') return line;
    const redacted = redactJsonValue(payload.trim());
    return redacted === null ? line : `${prefix}${redacted}${cr}`;
  });
}

/** Find the end of a JSON-like value, including an incomplete final value. */
function findJsonLikeValueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === first) return index + 1;
    }
    return text.length;
  }
  if (first === '{' || first === '[') {
    const opening = first;
    const closing = first === '{' ? '}' : ']';
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === opening) depth += 1;
      else if (char === closing && --depth === 0) return index + 1;
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[\r\n,}\]]/.test(text[end]!)) end += 1;
  return end;
}

/**
 * Mask values in arbitrary or byte-truncated JSON text. Once the sensitive key
 * is visible, an incomplete value is conservatively consumed to EOF so no
 * captured prefix of opaque Responses state can reach persistence.
 */
function redactEncryptedContentText(text: string): string {
  const key = /["']encrypted_content["']\s*:\s*/g;
  let output = '';
  let cursor = 0;
  for (;;) {
    const match = key.exec(text);
    if (!match) break;
    const valueStart = match.index + match[0].length;
    const valueEnd = findJsonLikeValueEnd(text, valueStart);
    output += text.slice(cursor, valueStart) + JSON.stringify(AUDIT_REDACTED);
    cursor = valueEnd;
    key.lastIndex = valueEnd;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

/** Remove opaque Responses state from JSON, SSE, or truncated audit text. */
function redactEncryptedContent(text: string): string {
  const completeJson = redactJsonValue(text);
  if (completeJson !== null) return completeJson;
  return redactEncryptedContentText(redactEncryptedContentSse(text));
}

/**
 * Mask obvious secrets in `text`. Pure; returns the input unchanged when it holds
 * no recognized secret shape. Never throws (a bad input returns `''`).
 */
export function redactAuditText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text ?? '';
  let out = redactEncryptedContent(text);
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace);
  }
  return out;
}
