/**
 * resolveEnvKey.ts — the daemon's single `$ENV_VAR` resolver (design D6).
 *
 * The `ApiKeyPoolService` needs an `ApiKeyResolver` (`(raw) => resolved`) with
 * the SAME semantics core's per-ingress `resolveApiKey` uses (`routeResolver.ts`
 * / `*Ingress.ts`): a `$VAR` reference resolves to `process.env[VAR]` (empty
 * string when unset), anything else passes through literally. This is the ONE
 * daemon-side implementation `buildDaemon` feeds the pool, so the pool's
 * resolution matches what core does for the row's single `api_key`.
 *
 * We do NOT touch core's per-ingress copies (those are core; zero core edit) —
 * this only guarantees the daemon-supplied resolver is byte-equivalent.
 *
 * @module @omnicross/daemon/pool/resolveEnvKey
 */

/**
 * Resolve an `$ENV_VAR` reference to its environment value, or return the
 * literal key. `$VAR` → `process.env[VAR]` (or `''` when unset); a non-`$`
 * literal passes through unchanged. Empty input → `''`.
 *
 * Matches core's `resolveApiKey` exactly (`process.env[name] || ''`).
 */
export function resolveEnvKey(rawKey: string): string {
  if (!rawKey) return '';
  if (rawKey.startsWith('$')) {
    return process.env[rawKey.slice(1)] || '';
  }
  return rawKey;
}
