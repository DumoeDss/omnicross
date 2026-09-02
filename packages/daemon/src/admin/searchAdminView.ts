/**
 * searchAdminView — secret-free projection of the `search` config section
 * (search-settings-ui, design D2).
 *
 * The section's own validator promises "nothing here ever echoes a configured
 * VALUE"; until this module existed the admin GET/PUT-echo broke that promise by
 * serializing provider `apiKey` / `basicAuthPassword` in plaintext. Two pure
 * helpers close it, beside the admin router like `proxy/sanitizeProxy.ts`:
 *
 * - {@link redactSearchServerConfig} drops each provider's secret fields and
 *   replaces them with `apiKeyConfigured` / `basicAuthPasswordConfigured`
 *   presence markers (the Images `storageRootConfigured` convention). Applied at
 *   BOTH admin echo sites (GET + PUT echo).
 * - {@link preserveSearchSecrets} gives secret fields write-only semantics on
 *   PUT — the established `OutboundKeyPolicyPatch` three-way idiom: omitted or
 *   blank KEEPS the stored value (editing host/policy/modes never wipes a key),
 *   a non-empty string SETS it, and JSON `null` CLEARS it. Presence markers
 *   arriving from a client are stripped so they can never persist as config.
 *
 * Why markers rather than masked sentinel strings: the proxy convention (drop
 * the field) cannot distinguish "jina configured keyless" from "jina configured
 * with a key", and the UI must show that honestly. `•••`-style sentinels invite
 * round-trip bugs and leak length information.
 *
 * @module @omnicross/daemon/admin/searchAdminView
 */

import type { SearchServerConfig } from '@omnicross/core/outbound-api/types';

/**
 * One provider entry as an admin client may see it: the non-secret members plus
 * presence markers standing where the secrets were.
 */
export interface SearchProviderConfigView {
  /** Host override (non-secret — the operator typed it in a form). */
  apiHost?: string;
  /** Basic-auth username (non-secret by the spec's round-trip list). */
  basicAuthUsername?: string;
  /** Admin-read marker: an `apiKey` is stored. Strip before writing. */
  apiKeyConfigured?: boolean;
  /** Admin-read marker: a `basicAuthPassword` is stored. Strip before writing. */
  basicAuthPasswordConfigured?: boolean;
}

/** The `search` section as an admin client may see it. */
export type SearchServerConfigView = Omit<SearchServerConfig, 'providers'> & {
  providers: Record<string, SearchProviderConfigView>;
};

/** Provider entries whose shape carries an API key. */
const API_KEY_PROVIDERS: ReadonlySet<string> = new Set(['tavily', 'jina', 'zhipu', 'z.ai']);
/** Provider entries whose shape carries a Basic-auth password. */
const BASIC_AUTH_PROVIDERS: ReadonlySet<string> = new Set(['searxng']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Project the `search` section to its secret-free admin view.
 *
 * Non-secret members (`modes`, `egress`, `policy`, `apiHost`,
 * `basicAuthUsername`, which entries exist) round-trip unchanged; every secret
 * VALUE is dropped in favor of a presence marker. A provider with no secret
 * stored reads as marker-`false` — the keyless and key-optional shapes stay
 * distinguishable from "secret present".
 */
export function redactSearchServerConfig(search: SearchServerConfig): SearchServerConfigView {
  const providers: Record<string, SearchProviderConfigView> = {};
  for (const [id, raw] of Object.entries(search.providers)) {
    // Widened read of the per-id entry union: every member's fields are
    // optional from here on, and absent stays absent.
    const entry = raw as Partial<{
      apiHost: string;
      basicAuthUsername: string;
      apiKey: string;
      basicAuthPassword: string;
    }>;
    const view: SearchProviderConfigView = {};
    if (entry.apiHost !== undefined) view.apiHost = entry.apiHost;
    if (entry.basicAuthUsername !== undefined) view.basicAuthUsername = entry.basicAuthUsername;
    // Per-id markers: a normalized entry only ever carries its own shape's
    // fields, so the marker says "this provider's secret slot is filled", never
    // inventing a slot the provider does not have.
    if (API_KEY_PROVIDERS.has(id)) {
      view.apiKeyConfigured = typeof entry.apiKey === 'string' && entry.apiKey.length > 0;
    }
    if (BASIC_AUTH_PROVIDERS.has(id)) {
      view.basicAuthPasswordConfigured =
        typeof entry.basicAuthPassword === 'string' && entry.basicAuthPassword.length > 0;
    }
    providers[id] = view;
  }
  return {
    modes: search.modes,
    providers,
    egress: { allowedPrivateHosts: [...search.egress.allowedPrivateHosts] },
    policy: { ...search.policy, ...(search.policy.allowed ? { allowed: [...search.policy.allowed] } : {}) },
  };
}

/** Structural read of one stored provider entry's secret slots (both optional). */
function storedSecrets(
  current: SearchServerConfig,
  id: string,
): { apiKey?: string; basicAuthPassword?: string } {
  const entry = (current.providers as Record<string, { apiKey?: string; basicAuthPassword?: string }>)[id];
  if (!entry) return {};
  const out: { apiKey?: string; basicAuthPassword?: string } = {};
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) out.apiKey = entry.apiKey;
  if (typeof entry.basicAuthPassword === 'string' && entry.basicAuthPassword.length > 0) {
    out.basicAuthPassword = entry.basicAuthPassword;
  }
  return out;
}

/**
 * Resolve one secret field's three-way contract onto `entry`, in place.
 *
 * - absent → keep the stored value when one exists (nothing is wiped implicitly);
 * - `null` → explicit clear: the field is removed. An entry that REQUIRED it now
 *   fails `validateSearchServerConfig` with a field-naming 400 — by design; the
 *   UI's clear affordance for required keys removes the whole entry instead.
 * - non-empty string → set;
 * - blank (or non-string garbage) → keep the stored value when one exists.
 */
function resolveSecretField(
  entry: Record<string, unknown>,
  field: 'apiKey' | 'basicAuthPassword',
  stored: string | undefined,
): void {
  if (!(field in entry)) {
    if (stored !== undefined) entry[field] = stored;
    return;
  }
  const value = entry[field];
  if (value === null) {
    delete entry[field];
    return;
  }
  if (typeof value === 'string' && value.trim().length > 0) return;
  if (stored !== undefined) entry[field] = stored;
  else delete entry[field];
}

/**
 * Write-only secret preservation for an incoming `search` PUT segment.
 *
 * Strips the admin-view presence markers, then re-attaches each provider's
 * stored secrets for fields the patch omits or blanks. A provider entry removed
 * from `providers` stays removed — layer-replace semantics apply to the entry
 * itself, and removal is how a configuration (including its secret) is deleted.
 * Non-object segments pass through untouched for `validateSearchServerConfig`
 * to reject with its own field-naming error.
 */
export function preserveSearchSecrets(incoming: unknown, current: SearchServerConfig): unknown {
  if (!isRecord(incoming)) return incoming;
  const section: Record<string, unknown> = { ...incoming };
  const providersValue = section['providers'];
  if (!isRecord(providersValue)) return section;

  const providers: Record<string, unknown> = {};
  for (const [id, entryValue] of Object.entries(providersValue)) {
    if (!isRecord(entryValue)) {
      providers[id] = entryValue;
      continue;
    }
    const entry: Record<string, unknown> = { ...entryValue };
    // View-only markers must never persist as config.
    delete entry['apiKeyConfigured'];
    delete entry['basicAuthPasswordConfigured'];
    const stored = storedSecrets(current, id);
    resolveSecretField(entry, 'apiKey', stored.apiKey);
    resolveSecretField(entry, 'basicAuthPassword', stored.basicAuthPassword);
    providers[id] = entry;
  }
  section['providers'] = providers;
  return section;
}
