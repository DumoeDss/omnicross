/**
 * searchSettingsModel.ts — the pure model behind the Search settings section
 * (search-settings-ui, design D5/D6).
 *
 * Three jobs, all no-React and table-testable:
 *
 * 1. The CLOSED provider catalog — exactly the seven built-in ids, with display
 *    metadata. No `local-*`, no grok/claude/exa/bocha: those are Elftia-host
 *    concepts or declared-but-dead ids, and the section must not advertise
 *    them.
 * 2. Masked-read → editable draft → PUT payload. The daemon never sends secret
 *    values, so the draft carries WRITE-ONLY inputs: blank keeps the stored
 *    value, a typed string sets it, and an explicit clear is `null` for
 *    OPTIONAL secrets (jina key, searxng Basic-auth password) or whole-entry
 *    removal for required ones (tavily/zhipu/z.ai keys, searxng host) — a
 *    null-cleared required key is a 400 by design.
 * 3. Honesty helpers: client-side clamps mirroring the daemon validator
 *    (maxAttempts 1..32, host string rules) so routine mistakes never round-trip
 *    into a 400, and the pending-restart provider-set comparison.
 */

import type {
  SearchDiagnosticsSnapshot,
  SearchFrontendMode,
  SearchFrontendModes,
  SearchServerConfig,
} from '@/daemon/types';

// ── Catalog ───────────────────────────────────────────────────────────────────

/** One built-in provider the section may show. */
export interface SearchProviderCatalogEntry {
  /** The wire id (also the config key). */
  id: string;
  /** i18n slug — `z.ai` becomes `zai` because dots nest in i18n keys. */
  i18nSlug: string;
  /** Brand display name (not localized — brand names are brand names). */
  name: string;
  kind: 'http' | 'api';
  website: string;
  /** Whether an API key is the required setting (its absence = unconfigured). */
  requiresApiKey: boolean;
  /** Whether a key is OPTIONAL (jina runs keyless). */
  keyOptional: boolean;
  /** Whether the HOST is the required setting (searxng). */
  requiresHost: boolean;
  /** Whether the optional `apiHost` override exists for this provider. */
  supportsHostOverride: boolean;
  /** Whether the Basic-auth pair applies (searxng only). */
  usesBasicAuth: boolean;
}

const HTTP_ENTRY: Omit<SearchProviderCatalogEntry, 'id' | 'i18nSlug' | 'name' | 'website'> = {
  kind: 'http',
  requiresApiKey: false,
  keyOptional: false,
  requiresHost: false,
  supportsHostOverride: false,
  usesBasicAuth: false,
};

const KEYED_ENTRY: Omit<SearchProviderCatalogEntry, 'id' | 'i18nSlug' | 'name' | 'website' | 'keyOptional' | 'requiresHost' | 'usesBasicAuth'> = {
  kind: 'api',
  requiresApiKey: true,
  supportsHostOverride: true,
};

/**
 * The complete catalog — EXACTLY the seven Phase-1 built-ins. `http-bing` and
 * `http-duckduckgo` are keyless and always available (no config fields, no
 * fake enable toggle); the five keyed ids configure-by-entry.
 */
export const SEARCH_PROVIDER_CATALOG: readonly SearchProviderCatalogEntry[] = Object.freeze([
  Object.freeze({ id: 'http-bing', i18nSlug: 'httpBing', name: 'Bing (HTTP)', website: 'https://www.bing.com', ...HTTP_ENTRY }),
  Object.freeze({ id: 'http-duckduckgo', i18nSlug: 'httpDuckduckgo', name: 'DuckDuckGo (HTTP)', website: 'https://duckduckgo.com', ...HTTP_ENTRY }),
  Object.freeze({ id: 'tavily', i18nSlug: 'tavily', name: 'Tavily', website: 'https://tavily.com', ...KEYED_ENTRY, keyOptional: false, requiresHost: false, usesBasicAuth: false }),
  Object.freeze({ id: 'jina', i18nSlug: 'jina', name: 'Jina', website: 'https://jina.ai', ...KEYED_ENTRY, keyOptional: true, requiresHost: false, usesBasicAuth: false }),
  Object.freeze({ id: 'searxng', i18nSlug: 'searxng', name: 'SearXNG', website: 'https://docs.searxng.org', kind: 'api', requiresApiKey: false, keyOptional: false, requiresHost: true, supportsHostOverride: false, usesBasicAuth: true }),
  Object.freeze({ id: 'zhipu', i18nSlug: 'zhipu', name: 'Zhipu', website: 'https://open.bigmodel.cn', ...KEYED_ENTRY, keyOptional: false, requiresHost: false, usesBasicAuth: false }),
  Object.freeze({ id: 'z.ai', i18nSlug: 'zai', name: 'Z.AI', website: 'https://z.ai', ...KEYED_ENTRY, keyOptional: false, requiresHost: false, usesBasicAuth: false }),
]);

const CATALOG_IDS: ReadonlySet<string> = new Set(SEARCH_PROVIDER_CATALOG.map((entry) => entry.id));

/** Whether an id is one of the seven built-ins (guards unknown ids at the edges). */
export function isCatalogProviderId(id: string): boolean {
  return CATALOG_IDS.has(id);
}

/** The two keyless ids — always available, never configured away. */
export const KEYLESS_HTTP_PROVIDER_IDS: readonly string[] = Object.freeze(['http-bing', 'http-duckduckgo']);

// ── Draft ─────────────────────────────────────────────────────────────────────

/** One keyed provider's editable state. Secret inputs are WRITE-ONLY. */
export interface SearchProviderDraft {
  /** Write-only key input. Blank keeps the stored value (daemon preserves). */
  apiKeyInput: string;
  /** Explicit clear of an OPTIONAL key → payload `null`. Required keys clear by entry removal. */
  clearApiKey: boolean;
  /** Optional `apiHost` override (or the REQUIRED host for searxng). */
  apiHost: string;
  /** Basic-auth username (searxng only; non-secret). */
  basicAuthUsername: string;
  /** Write-only Basic-auth password input (searxng only). */
  basicAuthPasswordInput: string;
  /** Explicit clear of the optional Basic-auth password → payload `null`. */
  clearBasicAuthPassword: boolean;
  /** Whether the persisted config carried this entry when the draft was built. */
  persistedConfigured: boolean;
  /** User pressed "remove configuration" — the payload omits the entry. */
  removed: boolean;
}

/** The whole section's editable state. */
export interface SearchSettingsDraft {
  modes: SearchFrontendModes;
  /** Keyed providers only (the http pair has nothing to edit). */
  providers: Record<string, SearchProviderDraft>;
  allowedPrivateHosts: string[];
  policy: {
    /** '' means no preference. */
    preferred: string;
    /** Selected allowed ids (subset of the catalog; empty = allow all). */
    allowed: string[];
    fallbackEnabled: boolean;
    /** Input as text — clamped at payload time. */
    maxAttempts: string;
  };
}

function emptyProviderDraft(persistedConfigured: boolean): SearchProviderDraft {
  return {
    apiKeyInput: '',
    clearApiKey: false,
    apiHost: '',
    basicAuthUsername: '',
    basicAuthPasswordInput: '',
    clearBasicAuthPassword: false,
    persistedConfigured,
    removed: false,
  };
}

/** Masked admin read → editable draft. Tolerant of an absent (pre-Phase-1) section. */
export function createSearchSettingsDraft(masked: SearchServerConfig | undefined): SearchSettingsDraft {
  const providers: Record<string, SearchProviderDraft> = {};
  for (const entry of SEARCH_PROVIDER_CATALOG) {
    if (entry.kind !== 'api') continue;
    const stored = masked?.providers[entry.id as keyof SearchServerConfig['providers']];
    const draft = emptyProviderDraft(stored !== undefined);
    if (stored) {
      draft.apiHost = stored.apiHost ?? '';
      draft.basicAuthUsername = (stored as { basicAuthUsername?: string }).basicAuthUsername ?? '';
    }
    providers[entry.id] = draft;
  }
  return {
    modes: masked?.modes ?? { codex: 'off', responses: 'native', anthropic: 'native' },
    providers,
    allowedPrivateHosts: [...(masked?.egress.allowedPrivateHosts ?? [])],
    policy: {
      preferred: masked?.policy.preferred ?? '',
      allowed: [...(masked?.policy.allowed ?? [])],
      fallbackEnabled: masked?.policy.fallbackEnabled !== false,
      maxAttempts: masked?.policy.maxAttempts !== undefined ? String(masked.policy.maxAttempts) : '',
    },
  };
}

// ── Clamps (mirror the daemon validator so routine mistakes never 400) ────────

export const SEARCH_MAX_ATTEMPTS_LIMIT = 32;

/** Clamp a maxAttempts input into 1..32, or undefined when unset/invalid. */
export function clampMaxAttemptsInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(SEARCH_MAX_ATTEMPTS_LIMIT, Math.max(1, Math.round(parsed)));
}

/** Control characters that must never reach a header, a URL, or the config. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
/** Longest accepted single config string (mirrors the daemon's cap). */
const MAX_CONFIG_STRING = 2048;

/** Whether a host/URL string is usable as config (non-blank, bounded, no controls). */
export function isUsableHostString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CONFIG_STRING && !CONTROL_CHARS.test(trimmed);
}

// ── Draft → PUT payload ───────────────────────────────────────────────────────

type ProviderPayload = Record<string, unknown>;

/**
 * Draft → the FULL `search` segment for `PUT /server`.
 *
 * Provider-entry rules (D2/D6):
 * - an entry is INCLUDED exactly when the card would show it configured
 *   ({@link draftProviderConfigured}): a required-key provider needs a typed
 *   key or a stored one (persisted entry), searxng needs a usable host, and a
 *   key-optional provider is enabled by naming a key or a host. An EMPTY entry
 *   is never sent implicitly — a no-op save must not enable anything, and an
 *   unconfigured required-key entry would be a 400 by design;
 * - a `removed` draft entry OMITS the provider (its configuration including
 *   any stored secret is deleted — the required-key clear affordance);
 * - blank secret inputs OMIT the field (the daemon keeps the stored value);
 * - a typed secret SETS it;
 * - an explicit clear of an OPTIONAL secret sends JSON `null`.
 */
export function searchDraftToPayload(draft: SearchSettingsDraft): SearchServerConfig {
  const providers: Record<string, ProviderPayload> = {};
  for (const entry of SEARCH_PROVIDER_CATALOG) {
    if (entry.kind !== 'api') continue;
    const provider = draft.providers[entry.id];
    if (!provider || provider.removed) continue;
    if (!draftProviderConfigured(entry, provider)) continue;

    const host = provider.apiHost.trim();
    const payload: ProviderPayload = {};
    if (entry.supportsHostOverride && isUsableHostString(host)) payload.apiHost = host;
    if (entry.requiresHost) payload.apiHost = host;

    if (entry.usesBasicAuth) {
      const username = provider.basicAuthUsername.trim();
      if (username) payload.basicAuthUsername = username;
      if (provider.clearBasicAuthPassword) payload.basicAuthPassword = null;
      else {
        const password = provider.basicAuthPasswordInput.trim();
        if (password) payload.basicAuthPassword = password;
      }
    }

    if (provider.clearApiKey) {
      // OPTIONAL keys clear to null and the entry survives; REQUIRED keys
      // never reach here (the UI removes the entry instead) — sending null for
      // one would be the documented 400, so guard it defensively.
      if (entry.keyOptional) payload.apiKey = null;
    } else {
      const key = provider.apiKeyInput.trim();
      if (key) payload.apiKey = key;
    }

    providers[entry.id] = payload;
  }

  const maxAttempts = clampMaxAttemptsInput(draft.policy.maxAttempts);
  const allowed = draft.policy.allowed.filter((id) => CATALOG_IDS.has(id));
  return {
    modes: draft.modes,
    providers: providers as SearchServerConfig['providers'],
    egress: { allowedPrivateHosts: draft.allowedPrivateHosts.filter(isUsableHostString).slice(0, 64) },
    policy: {
      ...(draft.policy.preferred && CATALOG_IDS.has(draft.policy.preferred)
        ? { preferred: draft.policy.preferred }
        : {}),
      ...(allowed.length > 0 ? { allowed } : {}),
      fallbackEnabled: draft.policy.fallbackEnabled,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    },
  };
}

// ── Pending restart (design D4) ───────────────────────────────────────────────

/**
 * Provider ids whose configuration differs between the PERSISTED config and the
 * RUNNING runtime — each needs a daemon restart to take effect. A null
 * diagnostics snapshot (older daemon) reports nothing: the static
 * restart-required labels still carry the honesty.
 */
export function pendingRestartProviderIds(
  persisted: SearchServerConfig | undefined,
  diagnostics: SearchDiagnosticsSnapshot | null,
): string[] {
  if (!persisted || !diagnostics) return [];
  const persistedIds = new Set(
    Object.keys(persisted.providers ?? {}).filter((id) => CATALOG_IDS.has(id)),
  );
  // Rows WITHOUT the `unconfigured` status are the providers the RUNNING
  // runtime actually registered — an unconfigured row names a provider the
  // runtime does NOT hold.
  const runningIds = new Set(
    diagnostics.rows
      .filter((row) => row.status !== 'unconfigured')
      .map((row) => row.providerId)
      .filter((id) => CATALOG_IDS.has(id) && !id.startsWith('http-')),
  );
  const diverged = new Set<string>();
  for (const id of persistedIds) if (!runningIds.has(id)) diverged.add(id);
  for (const id of runningIds) if (!persistedIds.has(id)) diverged.add(id);
  return SEARCH_PROVIDER_CATALOG.filter((entry) => diverged.has(entry.id)).map((entry) => entry.id);
}

// ── Display helpers ────────────────────────────────────────────────────────────

/** Whether the draft's provider entry would exist in the next PUT payload. */
export function draftProviderConfigured(entry: SearchProviderCatalogEntry, draft: SearchProviderDraft): boolean {
  if (entry.kind !== 'api') return true; // the http pair is always available
  if (draft.removed) return false;
  if (entry.requiresHost) return isUsableHostString(draft.apiHost.trim());
  return draft.persistedConfigured || draft.apiKeyInput.trim().length > 0 ||
    (entry.keyOptional && isUsableHostString(draft.apiHost.trim()));
}

/** Status a card should badge with, given the diagnostics row (if any). */
export function providerDisplayStatus(
  configured: boolean,
  rowStatus: string | undefined,
): 'ready' | 'unconfigured' | 'healthy' | 'degraded' | 'blocked' | 'failed' {
  if (!configured) return 'unconfigured';
  return (rowStatus as 'ready') ?? 'ready';
}
