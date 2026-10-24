/**
 * The persisted `search` config section — tolerant read, strict report.
 *
 * Two functions over the same shape, exactly as the Images section does it:
 * {@link normalizeSearchServerConfig} never throws (a malformed member falls
 * back or is dropped, so a bad config cannot take the daemon down), and
 * {@link validateSearchServerConfig} says what was unusable so an operator can
 * fix it.
 *
 * **Nothing here ever echoes a configured VALUE.** Every validation message
 * names a FIELD. An API key, a Basic-auth password and an internal hostname are
 * all things a validation log must not leak, and the cheapest way to guarantee
 * that is a rule with no exceptions rather than a per-field judgement call.
 *
 * @module outbound-api/searchServerConfig
 */

import type {
  DeepseekProviderConfig,
  JinaProviderConfig,
  KeyedSearchProviderConfig,
  KeylessSearchProviderConfig,
  SearchApiProviderConfigs,
  SearxngProviderConfig,
  TavilyProviderConfig,
  ZhipuProviderConfig,
} from '../search/api/types';
import {
  DEFAULT_SEARCH_FRONTEND_MODES,
  normalizeSearchFrontendModes,
  validateSearchFrontendModes,
} from '../search/frontends';

import type { SearchHttpProviderConfigs, SearchServerConfig } from './types';

/** Upper bound on `policy.maxAttempts`; also the cap on `policy.allowed` length. */
const MAX_POLICY_ATTEMPTS = 32;
/** Upper bound on the egress allowlist. A list this long is a misconfiguration. */
const MAX_ALLOWED_PRIVATE_HOSTS = 64;
/** Longest accepted single config string (key, host, provider id). */
const MAX_CONFIG_STRING = 2048;

const PUBLIC_API_IDS = ['exa', 'parallel', 'firecrawl'] as const;
const KEYED_API_IDS = [
  'brave', 'kagi', 'kimi', 'synthetic', 'ollama', 'tinyfish',
  'perplexity', 'bocha', 'claude',
] as const;
const HTTP_IDS = [
  'http-bing', 'http-duckduckgo', 'http-startpage', 'http-ecosia', 'http-mojeek', 'public',
] as const;

/**
 * HTTP-only providers, behavior-preserving modes, public-only egress, fallback
 * on. Built fresh per call so no caller can mutate a shared array.
 */
function defaultSearchServerConfig(): SearchServerConfig {
  return {
    modes: DEFAULT_SEARCH_FRONTEND_MODES,
    providers: {},
    egress: { allowedPrivateHosts: [] },
    policy: { fallbackEnabled: true, parallel: false },
  };
}

/** The frozen defaults, for comparison and for callers with no config at all. */
export const DEFAULT_SEARCH_SERVER_CONFIG: Readonly<SearchServerConfig> =
  Object.freeze(defaultSearchServerConfig());

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Control characters that must never reach a header, a URL, or a log line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** A usable config string: non-blank, bounded, no control characters. */
function configString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CONFIG_STRING) return undefined;
  return CONTROL_CHARS.test(trimmed) ? undefined : trimmed;
}

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const item = configString(entry);
    if (item !== undefined && !out.includes(item)) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

function tavilyConfig(value: unknown): TavilyProviderConfig | undefined {
  const raw = record(value);
  const apiKey = configString(raw?.['apiKey']);
  if (!apiKey) return undefined;
  const apiHost = configString(raw?.['apiHost']);
  return { apiKey, ...(apiHost ? { apiHost } : {}) };
}

function jinaConfig(value: unknown): JinaProviderConfig | undefined {
  // Jina is the one adapter that runs keyless, so an entry with neither key nor
  // host is still meaningful: it means "enable the keyless Jina provider".
  const raw = record(value);
  if (!raw) return undefined;
  const apiKey = configString(raw['apiKey']);
  const apiHost = configString(raw['apiHost']);
  return { ...(apiKey ? { apiKey } : {}), ...(apiHost ? { apiHost } : {}) };
}

function searxngConfig(value: unknown): SearxngProviderConfig | undefined {
  const raw = record(value);
  const apiHost = configString(raw?.['apiHost']);
  if (!apiHost) return undefined;
  const basicAuthUsername = configString(raw?.['basicAuthUsername']);
  const basicAuthPassword = configString(raw?.['basicAuthPassword']);
  return {
    apiHost,
    ...(basicAuthUsername ? { basicAuthUsername } : {}),
    ...(basicAuthPassword ? { basicAuthPassword } : {}),
  };
}

function zhipuConfig(value: unknown): ZhipuProviderConfig | undefined {
  const raw = record(value);
  const apiKey = configString(raw?.['apiKey']);
  if (!apiKey) return undefined;
  const apiHost = configString(raw?.['apiHost']);
  return { apiKey, ...(apiHost ? { apiHost } : {}) };
}

function deepseekConfig(value: unknown): DeepseekProviderConfig | undefined {
  // An entry with neither key nor host is STILL meaningful: it says "enable
  // DeepSeek and reuse the official key from an LLM provider row". Requiring a
  // key here would reject exactly the reuse case the provider exists for.
  const raw = record(value);
  if (!raw) return undefined;
  const apiKey = configString(raw['apiKey']);
  const apiHost = configString(raw['apiHost']);
  return { ...(apiKey ? { apiKey } : {}), ...(apiHost ? { apiHost } : {}) };
}

function publicApiConfig(value: unknown): KeylessSearchProviderConfig | undefined {
  const raw = record(value);
  if (!raw || (raw['authMode'] !== undefined && raw['authMode'] !== 'public' && raw['authMode'] !== 'api')) {
    return undefined;
  }
  const apiKey = configString(raw['apiKey']);
  const authMode = raw['authMode'] ??
    (typeof raw['apiKey'] === 'string' && raw['apiKey'].trim() ? 'api' : 'public');
  if (authMode === 'api' && !apiKey) return undefined;
  const apiHost = configString(raw['apiHost']);
  return {
    authMode,
    ...(apiKey ? { apiKey } : {}),
    ...(apiHost ? { apiHost } : {}),
  };
}

function keyedApiConfig(value: unknown): KeyedSearchProviderConfig | undefined {
  const base = tavilyConfig(value);
  if (!base) return undefined;
  const model = configString(record(value)?.['model']);
  return { ...base, ...(model ? { model } : {}) };
}

function httpProviderConfigs(value: unknown): SearchHttpProviderConfigs {
  const raw = record(value) ?? {};
  const configs: SearchHttpProviderConfigs = {};
  for (const id of HTTP_IDS) {
    const entry = record(raw[id]);
    if (!entry || (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean')) continue;
    configs[id] = { enabled: entry['enabled'] !== false };
  }
  return configs;
}

/** Tolerant read: unusable members are DROPPED, which leaves them unconfigured. */
export function normalizeSearchApiProviderConfigs(value: unknown): SearchApiProviderConfigs {
  const raw = record(value) ?? {};
  const configs: SearchApiProviderConfigs = {};
  const tavily = tavilyConfig(raw['tavily']);
  if (tavily) configs.tavily = tavily;
  const jina = jinaConfig(raw['jina']);
  if (jina) configs.jina = jina;
  const searxng = searxngConfig(raw['searxng']);
  if (searxng) configs.searxng = searxng;
  const zhipu = zhipuConfig(raw['zhipu']);
  if (zhipu) configs.zhipu = zhipu;
  const zai = zhipuConfig(raw['z.ai']);
  if (zai) configs['z.ai'] = zai;
  const deepseek = deepseekConfig(raw['deepseek']);
  if (deepseek) configs.deepseek = deepseek;
  for (const id of PUBLIC_API_IDS) {
    const config = publicApiConfig(raw[id]);
    if (config) configs[id] = config;
  }
  for (const id of KEYED_API_IDS) {
    const config = keyedApiConfig(raw[id]);
    if (config) configs[id] = config;
  }
  return configs;
}

/** Tolerant read of the whole section. Never throws; an absent section is the default. */
export function normalizeSearchServerConfig(value: unknown): SearchServerConfig {
  const raw = record(value);
  if (!raw) return defaultSearchServerConfig();

  const egressRaw = record(raw['egress']) ?? {};
  const policyRaw = record(raw['policy']) ?? {};
  const preferred = configString(policyRaw['preferred']);
  const allowed = stringList(policyRaw['allowed'], MAX_POLICY_ATTEMPTS);
  const maxAttemptsRaw = policyRaw['maxAttempts'];
  const maxAttempts = typeof maxAttemptsRaw === 'number' &&
    Number.isSafeInteger(maxAttemptsRaw) && maxAttemptsRaw > 0
    ? Math.min(maxAttemptsRaw, MAX_POLICY_ATTEMPTS)
    : undefined;

  return {
    modes: normalizeSearchFrontendModes(raw['modes']),
    providers: {
      ...normalizeSearchApiProviderConfigs(raw['providers']),
      ...httpProviderConfigs(raw['providers']),
    },
    egress: {
      allowedPrivateHosts: stringList(
        egressRaw['allowedPrivateHosts'],
        MAX_ALLOWED_PRIVATE_HOSTS,
      ),
    },
    policy: {
      ...(preferred ? { preferred } : {}),
      ...(allowed.length > 0 ? { allowed } : {}),
      // Omitted means ON, matching `SearchPolicy`'s documented default.
      fallbackEnabled: policyRaw['fallbackEnabled'] !== false,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      // Omitted means OFF — the serial walk stays the zero-regression default.
      parallel: policyRaw['parallel'] === true,
    },
  };
}

const PROVIDER_KEYS: ReadonlySet<string> = new Set([
  'tavily', 'jina', 'searxng', 'zhipu', 'z.ai', 'deepseek',
  ...PUBLIC_API_IDS, ...KEYED_API_IDS, ...HTTP_IDS,
]);

/**
 * The setting whose absence makes a provider entry unusable.
 *
 * `jina` has none because it runs keyless. `deepseek` has none because a blank
 * key means "reuse the official key from an LLM provider row" — resolving that
 * is the assembly's job, and a config-level validator cannot see the catalog.
 */
const PROVIDER_REQUIRED_FIELD: Readonly<Record<string, string | undefined>> = Object.freeze({
  tavily: 'apiKey',
  jina: undefined,
  searxng: 'apiHost',
  zhipu: 'apiKey',
  'z.ai': 'apiKey',
  deepseek: undefined,
  ...Object.fromEntries(KEYED_API_IDS.map((id) => [id, 'apiKey'])),
});

function validateProviders(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  const raw = record(value);
  if (!raw) return [`${path}: expected an object`];
  const errors: string[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (!PROVIDER_KEYS.has(id)) {
      errors.push(`${path}.${id}: unknown search provider`);
      continue;
    }
    if (!record(entry)) {
      errors.push(`${path}.${id}: expected an object`);
      continue;
    }
    const config = entry as Record<string, unknown>;
    if ((HTTP_IDS as readonly string[]).includes(id)) {
      if (config['enabled'] !== undefined && typeof config['enabled'] !== 'boolean') {
        errors.push(`${path}.${id}.enabled: expected a boolean`);
      }
      continue;
    }
    if ((PUBLIC_API_IDS as readonly string[]).includes(id)) {
      const mode = config['authMode'];
      if (mode !== undefined && mode !== 'public' && mode !== 'api') {
        errors.push(`${path}.${id}.authMode: expected public or api`);
      } else if ((mode === 'api' || (mode === undefined &&
          typeof config['apiKey'] === 'string' && config['apiKey'].trim())) &&
          configString(config['apiKey']) === undefined) {
        errors.push(`${path}.${id}.apiKey: missing or unusable`);
      }
    }
    if (config['model'] !== undefined && configString(config['model']) === undefined) {
      errors.push(`${path}.${id}.model: missing or unusable`);
    }
    const required = PROVIDER_REQUIRED_FIELD[id];
    if (required !== undefined && configString((entry as Record<string, unknown>)[required]) === undefined) {
      errors.push(`${path}.${id}.${required}: missing or unusable`);
    }
  }
  return errors;
}

/**
 * Report what a `search` section got wrong, field by field.
 *
 * Returns `[]` for a valid (or absent) section. Callers surface the list the
 * way the Images config's errors are surfaced — reported, not thrown — because
 * a search misconfiguration must not prevent the gateway from serving text.
 */
export function validateSearchServerConfig(value: unknown, path = '$.search'): string[] {
  if (value === undefined) return [];
  const raw = record(value);
  if (!raw) return [`${path}: expected an object`];

  const errors: string[] = [
    ...validateSearchFrontendModes(raw['modes'], `${path}.modes`),
    ...validateProviders(raw['providers'], `${path}.providers`),
  ];

  const egress = raw['egress'];
  if (egress !== undefined) {
    const egressRaw = record(egress);
    if (!egressRaw) {
      errors.push(`${path}.egress: expected an object`);
    } else {
      const hosts = egressRaw['allowedPrivateHosts'];
      if (hosts !== undefined && !Array.isArray(hosts)) {
        errors.push(`${path}.egress.allowedPrivateHosts: expected an array of hostnames`);
      } else if (Array.isArray(hosts)) {
        if (hosts.length > MAX_ALLOWED_PRIVATE_HOSTS) {
          errors.push(
            `${path}.egress.allowedPrivateHosts: at most ${MAX_ALLOWED_PRIVATE_HOSTS} entries`,
          );
        }
        hosts.forEach((host, index) => {
          if (configString(host) === undefined) {
            errors.push(`${path}.egress.allowedPrivateHosts[${index}]: not a usable hostname`);
          }
        });
      }
    }
  }

  const policy = raw['policy'];
  if (policy !== undefined) {
    const policyRaw = record(policy);
    if (!policyRaw) {
      errors.push(`${path}.policy: expected an object`);
    } else {
      if (policyRaw['preferred'] !== undefined && configString(policyRaw['preferred']) === undefined) {
        errors.push(`${path}.policy.preferred: not a usable provider id`);
      }
      if (policyRaw['allowed'] !== undefined && !Array.isArray(policyRaw['allowed'])) {
        errors.push(`${path}.policy.allowed: expected an array of provider ids`);
      }
      if (
        policyRaw['fallbackEnabled'] !== undefined &&
        typeof policyRaw['fallbackEnabled'] !== 'boolean'
      ) {
        errors.push(`${path}.policy.fallbackEnabled: expected a boolean`);
      }
      if (policyRaw['parallel'] !== undefined && typeof policyRaw['parallel'] !== 'boolean') {
        errors.push(`${path}.policy.parallel: expected a boolean`);
      }
      const maxAttempts = policyRaw['maxAttempts'];
      if (
        maxAttempts !== undefined &&
        (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) ||
          maxAttempts <= 0 || maxAttempts > MAX_POLICY_ATTEMPTS)
      ) {
        errors.push(`${path}.policy.maxAttempts: expected an integer in 1..${MAX_POLICY_ATTEMPTS}`);
      }
    }
  }

  return errors;
}
