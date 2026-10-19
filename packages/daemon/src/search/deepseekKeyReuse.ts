/**
 * DeepSeek key reuse — one credential for the LLM route and the search tools.
 *
 * DeepSeek's search/fetch APIs (`/v1/tools/*`) are billed to the same official
 * account key as its chat models. An operator who already added a DeepSeek
 * provider row has therefore already supplied the key the search provider
 * needs; asking for it a second time in the search section would create a
 * duplicate secret to rotate, leak and forget.
 *
 * This module answers exactly one question — "is there an official DeepSeek key
 * in the LLM catalog?" — with no config writes and no logging. The answer is
 * derived from the ROW SHAPE, not from a user-visible convention:
 *
 * - the row must be enabled (`enabled !== false`, the catalog's own default);
 * - its `baseUrl` must point at `api.deepseek.com` (the official endpoint the
 *   preset writes). A custom id and a custom display name are fine; a proxy or
 *   relay host is NOT, because there the key belongs to that intermediary and
 *   reusing it against DeepSeek directly may not authenticate;
 * - the key is the row's single `apiKey`, or the first enabled key in its
 *   `apiKeys` pool — the same precedence the outbound path uses
 *   (`resolvePreferredApiKey`) and `$ENV_VAR` references are resolved here at
 *   call time, not baked in at assembly.
 *
 * The helper returns the key VALUE to the daemon's in-process credential path
 * only. Nothing here serializes it; callers pass it straight to an adapter,
 * whose transport redacts it from every failure message.
 *
 * @module @omnicross/daemon/search/deepseekKeyReuse
 */

import type { DaemonProviderConfig } from '../config';

/** The official DeepSeek API host. Keys on any other host are not reused. */
export const DEEPSEEK_OFFICIAL_HOSTNAME = 'api.deepseek.com';

/** Whether a base URL points at the official DeepSeek API host. */
export function isOfficialDeepseekBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === DEEPSEEK_OFFICIAL_HOSTNAME;
  } catch {
    // A malformed base URL is a broken provider row, not a DeepSeek one.
    return false;
  }
}

/**
 * The first enabled, official DeepSeek key in the catalog, or `undefined`.
 *
 * Row order is the catalog order (the same order the admin UI shows), so the
 * first match is deterministic and an operator can control it by ordering.
 */
export function deepseekLlmProviderApiKey(
  rows: readonly DaemonProviderConfig[],
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const row of rows) {
    if (row.enabled === false) continue;
    if (!isOfficialDeepseekBaseUrl(row.baseUrl)) continue;
    const key = resolveRowApiKey(row, env);
    if (key) return key;
  }
  return undefined;
}

/** Whether any enabled official DeepSeek row yields a usable key. */
export function hasReusableDeepseekKey(
  rows: readonly DaemonProviderConfig[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  return deepseekLlmProviderApiKey(rows, env) !== undefined;
}

/** A row's preferred key: single key first, then the first enabled pool key. */
function resolveRowApiKey(
  row: DaemonProviderConfig,
  env: Record<string, string | undefined>,
): string | undefined {
  const single = resolveEnvReference(row.apiKey, env);
  if (single) return single;
  for (const entry of row.apiKeys ?? []) {
    if (entry.enabled === false) continue;
    const poolKey = resolveEnvReference(entry.apiKey, env);
    if (poolKey) return poolKey;
  }
  return undefined;
}

/** Resolve a `$ENV_VAR` reference the way the outbound key path does. */
function resolveEnvReference(
  value: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('$')) return trimmed;
  const resolved = env[trimmed.slice(1)]?.trim();
  return resolved ? resolved : undefined;
}
