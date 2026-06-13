/**
 * Approximate input-token counter for OpenCodeGo scenario routing.
 *
 * The spec mandates cl100k_base encoding from `js-tiktoken`. We lazy-import
 * the encoder so unit tests that don't touch this file don't pay the load
 * cost, and so the module gracefully falls back to a chars/4 heuristic when
 * the dependency is missing (e.g. before `npm install` has run after pulling
 * the dep into package.json). The fallback is good enough for routing
 * decisions — we're picking between scenario buckets, not counting cost.
 */

type EncodeFn = (text: string) => number[];

let cachedEncode: EncodeFn | null = null;
let encoderResolved = false;

async function getEncoder(): Promise<EncodeFn | null> {
  if (encoderResolved) return cachedEncode;
  encoderResolved = true;
  try {
    // `js-tiktoken` is added to root `package.json` as part of this change.
    // `npm install` must run before this code is exercised in production.
    // We use a dynamic specifier so tsc doesn't try to resolve the module at
    // compile time — the module is loaded lazily at first call and the
    // fallback path covers the pre-install dev case.
    const specifier = 'js-tiktoken';
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
      getEncoding(name: string): { encode: EncodeFn };
    };
    const enc = mod.getEncoding('cl100k_base');
    cachedEncode = (text: string) => enc.encode(text);
  } catch (err) {
    console.warn(
      '[opencodego/token-count] js-tiktoken not available, falling back to chars/4 heuristic:',
      err instanceof Error ? err.message : String(err),
    );
    cachedEncode = null;
  }
  return cachedEncode;
}

/** Estimate token count for a single string. */
export async function estimateTokens(text: string): Promise<number> {
  if (!text) return 0;
  const encode = await getEncoder();
  if (encode) {
    return encode(text).length;
  }
  // Fallback: ~4 chars per token (conservative for CJK/code mix), same
  // heuristic used by the host proxy's mock-probe response builder.
  return Math.ceil(text.length / 4);
}

/** Synchronous chars/4 heuristic — used by the scenario router so the
 *  hot path is sync; the async tiktoken-backed version warms a cache. */
export function estimateTokensSync(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Warm the cl100k_base encoder cache. Call once at main startup; the
 * subsequent sync routing decisions can then reuse the cache via
 * `estimateTokensSyncCached`. Best-effort — silently no-ops on failure.
 */
export async function warmTokenEncoder(): Promise<void> {
  await getEncoder();
}

/**
 * Synchronous estimate that uses the cl100k_base encoder when it has been
 * warmed (i.e. `warmTokenEncoder` resolved) and falls back to chars/4
 * otherwise. The routing decision tolerates either, so we don't block
 * request handling on async encoder init.
 */
export function estimateTokensCachedSync(text: string): number {
  if (!text) return 0;
  if (cachedEncode) {
    return cachedEncode(text).length;
  }
  return Math.ceil(text.length / 4);
}
