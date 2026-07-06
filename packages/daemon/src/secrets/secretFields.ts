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

import type { AccountTokensConfig, ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { BillingConfig } from '@omnicross/contracts/billing-types';
import type { WebhookConfig } from '@omnicross/contracts/webhook-types';
import type { OutboundProxyConfig } from '@omnicross/core';

import type { DaemonConfig } from '../config';

import { isEnvelope } from './envelope';
import type { SecretBox } from './SecretBox';

/** A per-value string transform (the box's `encryptMaybe` or `decryptMaybe`). */
type ValueTransform = (value: string) => string;

/** Whether a `{ url }`-form proxy carries inline userinfo credentials. */
function urlHasInlineCredential(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username.length > 0 || u.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * Transform a `ProxyConfig`'s SECRET material (upstream-proxy):
 *  - structured form → the `password` field.
 *  - `{ url }` form with inline userinfo credentials → the WHOLE url string is
 *    treated as a secret (M4): encrypted to an `enc:` envelope at rest and
 *    restored on read, so a hand-authored credentialed proxy url is never stored
 *    in plaintext. Detection is direction-safe — the encrypt side matches the
 *    plaintext credentialed url, the decrypt side matches the `enc:` envelope.
 * A `$ENV`/already-`enc:` value is left untouched by the box (idempotent
 * tri-state). Pure — returns a new object only when a secret is present.
 */
function transformProxyConfig(cfg: ProxyConfig, fn: ValueTransform): ProxyConfig {
  if ('url' in cfg) {
    if (isEnvelope(cfg.url) || urlHasInlineCredential(cfg.url)) {
      return { url: fn(cfg.url) };
    }
    return cfg;
  }
  if (typeof cfg.password === 'string' && cfg.password.length > 0) {
    return { ...cfg, password: fn(cfg.password) };
  }
  return cfg;
}

/** Apply a transform to a whole `OutboundProxyConfig` segment (global + per-provider). */
function transformOutboundProxy(
  proxy: OutboundProxyConfig,
  fn: ValueTransform,
): OutboundProxyConfig {
  const next: OutboundProxyConfig = {};
  if (proxy.global) next.global = transformProxyConfig(proxy.global, fn);
  if (proxy.byProvider) {
    const byProvider: Record<string, ProxyConfig> = {};
    for (const [key, value] of Object.entries(proxy.byProvider)) {
      byProvider[key] = transformProxyConfig(value, fn);
    }
    next.byProvider = byProvider;
  }
  return next;
}

/** Encrypt-on-write the global/provider proxy passwords (settings-store path). */
export function encryptProxySegment(proxy: OutboundProxyConfig, box: SecretBox): OutboundProxyConfig {
  return transformOutboundProxy(proxy, (v) => box.encryptMaybe(v));
}

/** Decrypt-on-read the global/provider proxy passwords (settings-store path). */
export function decryptProxySegment(proxy: OutboundProxyConfig, box: SecretBox): OutboundProxyConfig {
  return transformOutboundProxy(proxy, (v) => box.decryptMaybe(v));
}

/**
 * Apply a transform to a whole `WebhookConfig` segment (webhook-notifications):
 * each destination's `secret` (its HMAC signing key) is the only secret. A
 * `$ENV`/already-`enc:` value is left untouched by the box (idempotent). Pure —
 * returns a new object; a secret-less destination is copied verbatim.
 */
function transformWebhookSegment(webhook: WebhookConfig, fn: ValueTransform): WebhookConfig {
  return {
    ...webhook,
    destinations: webhook.destinations.map((d) =>
      typeof d.secret === 'string' && d.secret.length > 0 ? { ...d, secret: fn(d.secret) } : d,
    ),
  };
}

/** Encrypt-on-write the webhook destination secrets (settings-store path). */
export function encryptWebhookSegment(webhook: WebhookConfig, box: SecretBox): WebhookConfig {
  return transformWebhookSegment(webhook, (v) => box.encryptMaybe(v));
}

/** Decrypt-on-read the webhook destination secrets (settings-store path). */
export function decryptWebhookSegment(webhook: WebhookConfig, box: SecretBox): WebhookConfig {
  return transformWebhookSegment(webhook, (v) => box.decryptMaybe(v));
}

/**
 * Apply a transform to a `BillingConfig` segment (billing-event-stream): the HMAC
 * `secret` is the only secret. A `$ENV`/already-`enc:` value is left untouched by
 * the box (idempotent). Pure — returns a new object only when a secret is present.
 */
function transformBillingSegment(billing: BillingConfig, fn: ValueTransform): BillingConfig {
  if (typeof billing.secret === 'string' && billing.secret.length > 0) {
    return { ...billing, secret: fn(billing.secret) };
  }
  return billing;
}

/** Encrypt-on-write the billing HMAC secret (settings-store path). */
export function encryptBillingSegment(billing: BillingConfig, box: SecretBox): BillingConfig {
  return transformBillingSegment(billing, (v) => box.encryptMaybe(v));
}

/** Decrypt-on-read the billing HMAC secret (settings-store path). */
export function decryptBillingSegment(billing: BillingConfig, box: SecretBox): BillingConfig {
  return transformBillingSegment(billing, (v) => box.decryptMaybe(v));
}

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
  // upstream-proxy + webhook-notifications + billing-event-stream: the
  // global/per-provider proxy passwords, each webhook destination `secret`, AND
  // the billing HMAC `secret` on `server` are secrets too.
  const proxy = cfg.server?.proxy;
  const webhook = cfg.server?.webhook;
  const billing = cfg.server?.billing;
  if (cfg.server && (proxy?.global || proxy?.byProvider || webhook || billing?.secret)) {
    next.server = { ...cfg.server };
    if (proxy && (proxy.global || proxy.byProvider)) {
      next.server.proxy = transformOutboundProxy(proxy, fn);
    }
    if (webhook) next.server.webhook = transformWebhookSegment(webhook, fn);
    if (billing?.secret) next.server.billing = transformBillingSegment(billing, fn);
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
          const nextEntry: Record<string, unknown> = {
            ...(entry as Record<string, unknown>),
            tokens: transformTokenBlock(
              (entry as { tokens: Record<string, unknown> }).tokens,
              fields,
              fn,
            ),
          };
          // upstream-proxy: the per-account proxy password is a secret too.
          const proxy = (entry as { proxy?: unknown }).proxy;
          if (proxy && typeof proxy === 'object') {
            nextEntry.proxy = transformProxyConfig(proxy as ProxyConfig, fn);
          }
          return nextEntry;
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
