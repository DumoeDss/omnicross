/**
 * loadPoolKeys.ts — the pool's `loadKeys(providerId)` factory (design D1/D5).
 *
 * Builds the `ApiKeysLoader` core's `ApiKeyPoolService` calls, reading from a
 * LIVE config getter (so a hot-reload — which swaps the catalog Map — is seen
 * on the next load after `invalidateCache`). Synthesis rules (D1):
 *  - row has a non-empty `apiKeys[]` → normalize each entry up to the full core
 *    `ApiKeyEntry` (fill `providerId`/`label`/`weight`/`enabled`/`sortOrder`).
 *  - else row has a non-empty single `apiKey` → synthesize ONE entry
 *    (`'<providerId>:default'`, weight 1, enabled) — the 1-key pool whose
 *    semantics are identical to single-key (`selectWeightedRoundRobin` short-
 *    circuits on length 1).
 *  - else → `[]` (no key).
 *
 * The in-memory `AutoDisableStore` is read during normalization: a key marked
 * auto-disabled in THIS process has its `enabled` flipped to `false`, so
 * `getAvailableKeys` skips it (D5 — the disable takes effect in-process even
 * though it is never written to disk).
 *
 * KEY-VALUE ACCESSOR (design D5, child-3 seam — NOW HOOKED): EVERY raw key value
 * flows through `readKeyValue` — the single point at-rest decryption is applied
 * (and nowhere else in the pool). It calls the SHARED `SecretBox.decryptMaybe`
 * (an `enc:` envelope → decrypt; `$ENV`/legacy plaintext → passthrough). Because
 * `loadConfig` already decrypts provider secrets, the live row reaching here is
 * normally already plaintext, so `decryptMaybe` is an IDEMPOTENT no-op — this is
 * the second-line safety net for any residual `enc:` value (design D5). When no
 * box is injected, the read is the identity passthrough (legacy behavior).
 * `resolveEnvKey` (the `$ENV` step) still runs AFTER, inside the pool, unchanged.
 *
 * The return type is `import type { ApiKeyEntry }` (type-only, litmus-compliant)
 * so any drift between the daemon's hand-authored row and core's shape is a
 * compile error here, the one normalization point.
 *
 * @module @omnicross/daemon/pool/loadPoolKeys
 */

import type { ApiKeyEntry } from '@omnicross/contracts/llm-config';

import type { DaemonApiKeyEntry, DaemonProviderConfig } from '../config';
import type { SecretBox } from '../secrets';

import type { AutoDisableStore } from './autoDisableStore';

/** Reads the live provider row for `providerId` (or `undefined` when absent). */
export type LiveProviderGetter = (providerId: string) => DaemonProviderConfig | undefined;

/**
 * Module-level at-rest `SecretBox` (secrets design D5/D7). `null` ⇒ the key read
 * is the identity passthrough (legacy behavior). bootstrap injects it at entry
 * (same box instance as config.ts).
 */
let secretBox: SecretBox | null = null;

/** Inject (or clear, with `null`) the module-level at-rest `SecretBox`. */
export function setSecretBox(box: SecretBox | null): void {
  secretBox = box;
}

/**
 * The single point every pool key's RAW value is read. At-rest decryption is
 * applied HERE (and nowhere else in the pool) via the shared box's idempotent
 * `decryptMaybe` — an `enc:` envelope decrypts, a `$ENV`/legacy plaintext value
 * passes through. No box → identity read.
 */
function readKeyValue(rawKey: string): string {
  return secretBox ? secretBox.decryptMaybe(rawKey) : rawKey;
}

/** Normalize one daemon pool entry up to the full core `ApiKeyEntry`. */
function normalizeEntry(
  providerId: string,
  entry: DaemonApiKeyEntry,
  sortOrder: number,
  autoDisabled: AutoDisableStore,
): ApiKeyEntry {
  const enabledInConfig = entry.enabled !== false;
  // An in-process auto-disable (401/403) forces `enabled:false` regardless of
  // the config flag, so `getAvailableKeys` skips it this process lifetime (D5).
  const enabled = enabledInConfig && !autoDisabled.isDisabled(entry.id);
  return {
    id: entry.id,
    providerId,
    label: entry.label && entry.label.length > 0 ? entry.label : entry.id,
    apiKey: readKeyValue(entry.apiKey),
    enabled,
    weight: typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 1,
    sortOrder,
  };
}

/**
 * Build the `loadKeys(providerId)` loader from a live config getter + the
 * in-memory auto-disable store. Synthesizes the `ApiKeyEntry[]` per D1.
 */
export function createPoolKeysLoader(
  getProviderRow: LiveProviderGetter,
  autoDisabled: AutoDisableStore,
): (providerId: string) => Promise<ApiKeyEntry[]> {
  return async (providerId: string): Promise<ApiKeyEntry[]> => {
    const row = getProviderRow(providerId);
    if (!row) return [];

    const pool = (row.apiKeys ?? []).filter((k) => k.apiKey.length > 0);
    if (pool.length > 0) {
      return pool.map((entry, i) => normalizeEntry(providerId, entry, i, autoDisabled));
    }

    // Single-key fallback → a 1-key pool whose behavior matches single-key.
    if (row.apiKey.length > 0) {
      return [
        normalizeEntry(
          providerId,
          { id: `${providerId}:default`, apiKey: row.apiKey, weight: 1, enabled: true },
          0,
          autoDisabled,
        ),
      ];
    }

    return [];
  };
}
