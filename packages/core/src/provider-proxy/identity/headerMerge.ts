/**
 * headerMerge — the shared outbound-header merge primitive used by the
 * per-client header builders (`claudeCodeHeaders`, `codexCliHeaders`).
 *
 * Split out so neither builder has to import the other just to reuse the merge.
 *
 * @module provider-proxy/identity/headerMerge
 */

/**
 * Copy every entry of `source` into `headers` that `headers` does not already
 * carry (case-insensitive on the existing keys, so an `Authorization` set by the
 * auth strategy is never shadowed by an `authorization` from a caller bag).
 * Existing values ALWAYS win — this only fills empty slots, which is what makes
 * the precedence chain (auth > frozen fingerprint > caller > defaults) work by
 * simply calling it in order.
 */
export function fillMissingHeaders(
  headers: Record<string, string>,
  source: Readonly<Record<string, string>>,
): void {
  const present = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (present.has(lower)) continue;
    headers[lower] = value;
    present.add(lower);
  }
}

/** Flatten a node `IncomingHttpHeaders` value to a single non-empty string. */
export function flattenHeaderValue(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string').join(', ') : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Never forwardable from a caller, whatever a builder's allow-list says — the
 * token/secret set plus the hop-by-hop and body-framing headers the relay
 * recomputes. Belt and braces behind each builder's positive allow-list.
 */
export const NEVER_FORWARD_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
  'host',
  'connection',
  'content-length',
  'content-type',
  'accept-encoding',
]);
