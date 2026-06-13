/**
 * Robust error serialization utility.
 *
 * Handles all error types (Error, API SDK structured errors, plain objects,
 * primitives) and produces a human-readable string suitable for logging.
 *
 * Motivation: The Claude Agent SDK (and many HTTP client libraries) may throw
 * structured error objects that are NOT `instanceof Error`. Using `String(err)`
 * on such objects yields the useless "[object Object]" in logs.
 */

/**
 * Convert any thrown value into a descriptive string for logging / IPC.
 *
 * Priority:
 * 1. `Error` instance → `message` (+ `cause` if present)
 * 2. Object with `.message` string → use it
 * 3. Object with `.error` string → use it (Anthropic API error shape)
 * 4. Object with `.error.message` → use it (nested API error shape)
 * 5. Non-empty string → use directly
 * 6. Fallback → `JSON.stringify` (with circular-ref safety)
 */
export function serializeError(err: unknown): string {
  // Null / undefined
  if (err == null) return 'Unknown error (null)';

  // Standard Error instances (including subclasses like TypeError, RangeError, SDK errors)
  if (err instanceof Error) {
    let msg = err.message || err.name || 'Error';
    // Append cause chain for better debugging
    if (err.cause) {
      msg += ` [cause: ${serializeError(err.cause)}]`;
    }
    // Append status/code if present (common in HTTP client errors)
    const anyErr = err as unknown as Record<string, unknown>;
    if (anyErr.status != null) msg += ` (status: ${anyErr.status})`;
    else if (anyErr.code != null) msg += ` (code: ${anyErr.code})`;
    return msg;
  }

  // Primitives: string, number, boolean
  if (typeof err === 'string') return err || 'Empty error string';
  if (typeof err !== 'object') return String(err);

  // Structured objects (API error responses, SDK error payloads, etc.)
  const obj = err as Record<string, unknown>;

  // { message: "..." }
  if (typeof obj.message === 'string' && obj.message) {
    let msg = obj.message;
    if (obj.status != null) msg += ` (status: ${obj.status})`;
    else if (obj.code != null) msg += ` (code: ${obj.code})`;
    if (typeof obj.type === 'string') msg += ` [type: ${obj.type}]`;
    return msg;
  }

  // { error: "..." } — common in Anthropic API responses
  if (typeof obj.error === 'string' && obj.error) {
    return obj.error;
  }

  // { error: { message: "...", type: "..." } } — nested Anthropic error
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.message === 'string' && inner.message) {
      let msg = inner.message;
      if (typeof inner.type === 'string') msg += ` [type: ${inner.type}]`;
      return msg;
    }
  }

  // Last resort: safe JSON.stringify
  try {
    const json = JSON.stringify(err, getCircularReplacer(), 2);
    // Truncate very long JSON to keep logs readable
    if (json && json.length > 1000) {
      return json.slice(0, 1000) + '... (truncated)';
    }
    return json || 'Unserializable error';
  } catch {
    return `Unserializable error: ${Object.prototype.toString.call(err)}`;
  }
}

/** JSON.stringify replacer that handles circular references */
function getCircularReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}
