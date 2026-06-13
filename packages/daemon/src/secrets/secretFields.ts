/**
 * secretFields.ts — the pure field-selectors that know WHICH config/tokens
 * fields are secret (secrets design D7).
 *
 * `encryptConfigSecrets` / `decryptConfigSecrets` walk a `DaemonConfig` and
 * transform ONLY the secret string fields through the box's tri-state
 * `encryptMaybe` / `decryptMaybe`:
 *  - each provider's `apiKey`
 *  - each provider's `apiKeys[].apiKey`
 *  - each provider's `codingPlan.apiKey` (app-parity-2 child 3)
 *  - each provider's `apiModes[].apiKey` (app-parity-2 child 4)
 *  - `admin.token`
 * Every NON-secret field (`id`/`apiFormat`/`baseUrl`/`models`/`server`/
 * `admin.enabled|port|networkBinding`) is copied through verbatim.
 *
 * `encryptTokens` / `decryptTokens` walk an `AccountTokensConfig` and transform
 * ONLY the token-material fields:
 *  - claude/codex/gemini: `accessToken`, `refreshToken`, `idToken` (codex only)
 *  - opencodego: `apiKey`
 * Every other field (`authMethod`/`status`/`expiresAt`/`subscriptionLevel`/
 * `baseUrl`/`modelMap`/`fallbacks`/`updatedAt`/…) is copied through verbatim.
 *
 * All four are PURE: they return a NEW object (shallow-cloned at each touched
 * level) and never mutate the input. A `$ENV` reference or an already-`enc:`
 * value is left untouched by the box (idempotent), so applying these to a
 * mixed/legacy file is safe.
 *
 * @module @omnicross/daemon/secrets/secretFields
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';

import type { DaemonConfig } from '../config';

import type { SecretBox } from './SecretBox';

/** A per-value string transform (the box's `encryptMaybe` or `decryptMaybe`). */
type ValueTransform = (value: string) => string;

/** Apply a transform to one provider row's secret fields (pure; new object). */
function transformProvider(
  provider: DaemonConfig['providers'][number],
  fn: ValueTransform,
): DaemonConfig['providers'][number] {
  const next = { ...provider, apiKey: fn(provider.apiKey) };
  if (provider.apiKeys) {
    next.apiKeys = provider.apiKeys.map((entry) => ({ ...entry, apiKey: fn(entry.apiKey) }));
  }
  // app-parity-2 child 3: the coding-plan endpoint's own key is a secret too.
  // A `$ENV`/already-`enc:` value is left untouched by the box (idempotent tri-state).
  if (
    provider.codingPlan &&
    typeof provider.codingPlan.apiKey === 'string' &&
    provider.codingPlan.apiKey.length > 0
  ) {
    next.codingPlan = { ...provider.codingPlan, apiKey: fn(provider.codingPlan.apiKey) };
  }
  // app-parity-2 child 4: each API mode's own key is a secret too.
  if (provider.apiModes) {
    next.apiModes = provider.apiModes.map((mode) =>
      typeof mode.apiKey === 'string' && mode.apiKey.length > 0
        ? { ...mode, apiKey: fn(mode.apiKey) }
        : mode,
    );
  }
  return next;
}

/** Apply a transform to every secret config field (pure; new config object). */
function transformConfigSecrets(cfg: DaemonConfig, fn: ValueTransform): DaemonConfig {
  const next: DaemonConfig = {
    ...cfg,
    providers: cfg.providers.map((p) => transformProvider(p, fn)),
  };
  if (cfg.admin && typeof cfg.admin.token === 'string' && cfg.admin.token.length > 0) {
    next.admin = { ...cfg.admin, token: fn(cfg.admin.token) };
  }
  return next;
}

/** Encrypt-on-write: encrypt every legacy-plaintext config secret (idempotent). */
export function encryptConfigSecrets(cfg: DaemonConfig, box: SecretBox): DaemonConfig {
  return transformConfigSecrets(cfg, (v) => box.encryptMaybe(v));
}

/** Read-normalize: decrypt every `enc:` config secret, pass others through. */
export function decryptConfigSecrets(cfg: DaemonConfig, box: SecretBox): DaemonConfig {
  return transformConfigSecrets(cfg, (v) => box.decryptMaybe(v));
}

/** The token-material fields per provider block (everything else is metadata). */
const TOKEN_FIELDS: Record<string, readonly string[]> = {
  claude: ['accessToken', 'refreshToken'],
  codex: ['accessToken', 'refreshToken', 'idToken'],
  gemini: ['accessToken', 'refreshToken'],
  opencodego: ['apiKey'],
};

/** Apply a transform to one provider's token-material fields (pure; new block). */
function transformTokenBlock(
  block: Record<string, unknown>,
  fields: readonly string[],
  fn: ValueTransform,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...block };
  for (const field of fields) {
    const value = next[field];
    if (typeof value === 'string' && value.length > 0) {
      next[field] = fn(value);
    }
  }
  return next;
}

/**
 * Apply a transform to every token-material field (pure; new tokens object).
 *
 * Walks BOTH the four top-level provider blocks (the active mirror) AND each
 * provider's `<provider>Accounts[]` array, applying the SAME `TOKEN_FIELDS`
 * transform to every `entry.tokens` (subscription-multi-account D6). Account
 * metadata (`id`/`label`/`createdAt`) stays plaintext. Missing this would leave
 * account tokens in PLAINTEXT at rest.
 */
function transformTokens(tokens: AccountTokensConfig, fn: ValueTransform): AccountTokensConfig {
  const next = { ...tokens } as AccountTokensConfig & Record<string, unknown>;
  const bag = next as Record<string, unknown>;
  for (const [provider, fields] of Object.entries(TOKEN_FIELDS)) {
    // Top-level mirror block.
    const block = bag[provider];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      bag[provider] = transformTokenBlock(block as Record<string, unknown>, fields, fn);
    }

    // Per-account `<provider>Accounts[].tokens`.
    const accountsKey = `${provider}Accounts`;
    const accounts = bag[accountsKey];
    if (Array.isArray(accounts)) {
      bag[accountsKey] = accounts.map((entry) => {
        if (
          entry &&
          typeof entry === 'object' &&
          'tokens' in entry &&
          (entry as { tokens?: unknown }).tokens &&
          typeof (entry as { tokens?: unknown }).tokens === 'object'
        ) {
          return {
            ...(entry as Record<string, unknown>),
            tokens: transformTokenBlock(
              (entry as { tokens: Record<string, unknown> }).tokens,
              fields,
              fn,
            ),
          };
        }
        return entry;
      });
    }
  }
  return next;
}

/** Encrypt-on-write: encrypt every legacy-plaintext token field (idempotent). */
export function encryptTokens(tokens: AccountTokensConfig, box: SecretBox): AccountTokensConfig {
  return transformTokens(tokens, (v) => box.encryptMaybe(v));
}

/** Read-normalize: decrypt every `enc:` token field, pass others through. */
export function decryptTokens(tokens: AccountTokensConfig, box: SecretBox): AccountTokensConfig {
  return transformTokens(tokens, (v) => box.decryptMaybe(v));
}
