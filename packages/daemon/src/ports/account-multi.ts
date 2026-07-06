/**
 * account-multi — daemon-side pure helpers for the subscription multi-account
 * layout.
 *
 * Host-clean: no I/O, no encryption — callers persist through their own
 * encrypted writers.
 *
 * Load-bearing invariant: the top-level per-provider block is ALWAYS a byte-equal
 * mirror of the active account's `tokens`; every mutator re-derives it last.
 *
 * @module @omnicross/daemon/ports/account-multi
 */

import { randomUUID } from 'node:crypto';

import type {
  AccountTokensConfig,
  ClaudeTokenConfig,
  CodexTokenConfig,
  GeminiTokenConfig,
  ProxyConfig,
  SubscriptionAccountEntry,
  SubscriptionAccountSanitized,
  SyncWarningCode,
  TokenStatus,
} from '@omnicross/contracts/account-tokens-types';
import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';

import { sanitizeProxyConfig } from '../proxy/sanitizeProxy';

export type AnyTokenConfig =
  | ClaudeTokenConfig
  | CodexTokenConfig
  | GeminiTokenConfig
  | OpenCodeGoTokenConfig;

type AnyAccountEntry = SubscriptionAccountEntry<AnyTokenConfig>;

/** Provider id → owned contract field names. */
export type DaemonProvider = 'claude' | 'codex' | 'gemini' | 'opencodego';

interface ProviderKeys {
  block: keyof AccountTokensConfig;
  accounts: keyof AccountTokensConfig;
  active: keyof AccountTokensConfig;
}

const PROVIDER_KEYS: Record<DaemonProvider, ProviderKeys> = {
  claude: { block: 'claude', accounts: 'claudeAccounts', active: 'activeClaudeAccountId' },
  codex: { block: 'codex', accounts: 'codexAccounts', active: 'activeCodexAccountId' },
  gemini: { block: 'gemini', accounts: 'geminiAccounts', active: 'activeGeminiAccountId' },
  opencodego: {
    block: 'opencodego',
    accounts: 'opencodegoAccounts',
    active: 'activeOpencodegoAccountId',
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * DETERMINISTIC id for a single account synthesized from a legacy single-slot
 * block (design D3). Stable across reads so a not-yet-materialized legacy file
 * yields the SAME id on every `readConfig` — the refresh capture-then-re-read
 * write-back (and list→setActive/remove round-trips) keys against a consistent
 * id. Materializes byte-equal on the next write.
 */
export function legacyAccountId(provider: DaemonProvider): string {
  return `legacy-${provider}`;
}

function getAccounts(config: AccountTokensConfig, p: DaemonProvider): AnyAccountEntry[] {
  return (config[PROVIDER_KEYS[p].accounts] as AnyAccountEntry[] | undefined) ?? [];
}

function setAccounts(
  config: AccountTokensConfig,
  p: DaemonProvider,
  accounts: AnyAccountEntry[] | undefined,
): void {
  (config as Record<string, unknown>)[PROVIDER_KEYS[p].accounts] = accounts;
}

function getActiveId(config: AccountTokensConfig, p: DaemonProvider): string | undefined {
  return config[PROVIDER_KEYS[p].active] as string | undefined;
}

function setActiveId(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string | undefined,
): void {
  (config as Record<string, unknown>)[PROVIDER_KEYS[p].active] = id;
}

function getBlock(config: AccountTokensConfig, p: DaemonProvider): AnyTokenConfig | undefined {
  return config[PROVIDER_KEYS[p].block] as AnyTokenConfig | undefined;
}

function setBlock(
  config: AccountTokensConfig,
  p: DaemonProvider,
  block: AnyTokenConfig | undefined,
): void {
  (config as Record<string, unknown>)[PROVIDER_KEYS[p].block] = block;
}

/** Re-derive the top-level mirror from the CURRENT active id (clears when none). */
export function deriveMirror(config: AccountTokensConfig, p: DaemonProvider): void {
  const accounts = getAccounts(config, p);
  const active = accounts.find((a) => a.id === getActiveId(config, p));
  if (!active) {
    setBlock(config, p, undefined);
    setActiveId(config, p, undefined);
    if (accounts.length === 0) setAccounts(config, p, undefined);
    return;
  }
  setBlock(config, p, clone(active.tokens));
}

/**
 * Lazy, idempotent, read-pure migration. Synthesize a single account from a
 * legacy top-level block when no accounts array exists yet. The daemon is
 * headless → default label "Account 1". Caller materializes ids on next write.
 */
export function migrateLazily(config: AccountTokensConfig): AccountTokensConfig {
  const next: AccountTokensConfig = { ...config };
  for (const p of Object.keys(PROVIDER_KEYS) as DaemonProvider[]) {
    const block = getBlock(next, p);
    if (!block || getAccounts(next, p).length > 0) continue;
    const entry: AnyAccountEntry = {
      // DETERMINISTIC id — stable across reads.
      id: legacyAccountId(p),
      label: 'Account 1',
      createdAt: next.updatedAt || new Date().toISOString(),
      tokens: clone(block),
    };
    setAccounts(next, p, [entry]);
    setActiveId(next, p, entry.id);
    setBlock(next, p, clone(entry.tokens));
  }
  return next;
}

/** Append a new account + set active, re-derive the mirror. Returns the id. */
export function addAccount(
  config: AccountTokensConfig,
  p: DaemonProvider,
  tokens: AnyTokenConfig,
  label?: string,
): { id: string } {
  const accounts = [...getAccounts(config, p)];
  const id = randomUUID();
  accounts.push({
    id,
    label: label ?? `Account ${accounts.length + 1}`,
    createdAt: new Date().toISOString(),
    tokens: clone(tokens),
  });
  setAccounts(config, p, accounts);
  setActiveId(config, p, id);
  deriveMirror(config, p);
  return { id };
}

/** Remove an account; promote most-recent on active-removal, clear when empty. */
export function removeAccount(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
): { removed: boolean } {
  const accounts = getAccounts(config, p);
  if (!accounts.some((a) => a.id === id)) return { removed: false };

  const wasActive = getActiveId(config, p) === id;
  const remaining = accounts.filter((a) => a.id !== id);
  setAccounts(config, p, remaining.length ? remaining : undefined);

  if (wasActive) {
    setActiveId(config, p, remaining.length ? mostRecent(remaining).id : undefined);
  }
  deriveMirror(config, p);
  return { removed: true };
}

function mostRecent(accounts: AnyAccountEntry[]): AnyAccountEntry {
  return accounts.reduce((best, cur) => {
    const bestT = best.createdAt ? Date.parse(best.createdAt) : 0;
    const curT = cur.createdAt ? Date.parse(cur.createdAt) : 0;
    return curT >= bestT ? cur : best;
  }, accounts[0]);
}

/** Switch the active account; rejects an unknown id. Re-derives the mirror. */
export function setActiveAccount(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
): { ok: boolean } {
  if (!getAccounts(config, p).some((a) => a.id === id)) return { ok: false };
  setActiveId(config, p, id);
  deriveMirror(config, p);
  return { ok: true };
}

/** All account entries for a provider (read-side helper; external-cli-sync). */
export function listAccounts(
  config: AccountTokensConfig,
  p: DaemonProvider,
): SubscriptionAccountEntry<AnyTokenConfig>[] {
  return getAccounts(config, p);
}

/** One account's id + tokens by id (read-side helper for the by-id refresh). */
export function getAccountById(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
): { id: string; tokens: AnyTokenConfig } | undefined {
  const account = getAccounts(config, p).find((a) => a.id === id);
  return account ? { id: account.id, tokens: account.tokens } : undefined;
}

/**
 * One account's per-account proxy override by id (upstream-proxy). Returns the
 * DECRYPTED `ProxyConfig` (the caller passes a decrypted config), or `undefined`
 * when the account has no proxy. Feeds the per-account layer of the resolver.
 */
export function getAccountProxy(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
): ProxyConfig | undefined {
  return getAccounts(config, p).find((a) => a.id === id)?.proxy;
}

/** The active account's id + tokens (read-side helper for refresh capture). */
export function getActiveAccount(
  config: AccountTokensConfig,
  p: DaemonProvider,
): { id: string; tokens: AnyTokenConfig } | undefined {
  const active = getAccounts(config, p).find((a) => a.id === getActiveId(config, p));
  return active ? { id: active.id, tokens: active.tokens } : undefined;
}

/**
 * Write refreshed/expired token material back to the account whose id was
 * captured at read time (NOT the current active), then re-derive the mirror.
 */
export function writeBackRefreshById(
  config: AccountTokensConfig,
  p: DaemonProvider,
  capturedId: string | undefined,
  refreshedTokens: AnyTokenConfig,
): void {
  if (capturedId) {
    setAccounts(
      config,
      p,
      getAccounts(config, p).map((a) =>
        a.id === capturedId ? { ...a, tokens: clone(refreshedTokens) } : a,
      ),
    );
  }
  deriveMirror(config, p);
}

/**
 * Update the ACTIVE account's tokens (creating + activating a first account when
 * none exists yet — token-paste parity), then re-derive the mirror.
 */
export function writeActiveTokens(
  config: AccountTokensConfig,
  p: DaemonProvider,
  tokens: AnyTokenConfig,
): void {
  const active = getActiveAccount(config, p);
  if (active) {
    writeBackRefreshById(config, p, active.id, tokens);
  } else {
    addAccount(config, p, tokens);
  }
}

/**
 * Project one provider's accounts into the sanitized (secret-free) view. The
 * non-secret metadata (`authMethod` / `subscriptionLevel` / `lastRefreshedAt` /
 * `isSetupToken`) is carried through from the stored token block so the admin
 * account-row detail view can render it — a raw token / `enc:` envelope is NEVER
 * projected.
 */
export function sanitizeAccounts(
  config: AccountTokensConfig,
  p: DaemonProvider,
): SubscriptionAccountSanitized[] {
  const accounts = getAccounts(config, p);
  const activeId = getActiveId(config, p);
  return accounts.map((a) => {
    const t = a.tokens as {
      status?: TokenStatus;
      expiresAt?: string;
      accessToken?: string;
      apiKey?: string;
      authMethod?: string;
      subscriptionLevel?: string;
      lastRefreshedAt?: string;
      isSetupToken?: boolean;
      syncWarning?: SyncWarningCode;
    };
    return {
      id: a.id,
      label: a.label,
      status: (t.status ?? 'unconfigured') as TokenStatus,
      authMethod: t.authMethod,
      subscriptionLevel: t.subscriptionLevel,
      expiresAt: t.expiresAt,
      lastRefreshedAt: t.lastRefreshedAt,
      isSetupToken: t.isSetupToken,
      hasAccessToken: !!(t.accessToken || t.apiKey),
      isActive: a.id === activeId,
      // Scheduling metadata (subscription-account-scheduling): editable priority
      // (default 50 shown when unset) + display-only lastUsedAt. Secret-free.
      priority: a.priority,
      lastUsedAt: a.lastUsedAt,
      syncWarning: t.syncWarning,
      // Per-account proxy (upstream-proxy): masked view — password → hasPassword,
      // userinfo stripped. The plaintext password is NEVER projected.
      proxy: a.proxy ? sanitizeProxyConfig(a.proxy) : undefined,
    };
  });
}

/**
 * Rename one account's label (label-only — the token mirror is unaffected).
 * Rejects an unknown id. Used by the admin per-account rename route.
 */
export function renameAccount(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
  label: string,
): { ok: boolean } {
  const accounts = getAccounts(config, p);
  if (!accounts.some((a) => a.id === id)) return { ok: false };
  setAccounts(
    config,
    p,
    accounts.map((a) => (a.id === id ? { ...a, label } : a)),
  );
  return { ok: true };
}

/**
 * Set one account's scheduling `priority` by id (subscription-account-scheduling).
 * Entry-metadata only — the top-level token mirror (a clone of `tokens`) is
 * unaffected, so no `deriveMirror` is needed. Rejects an unknown id.
 */
export function setAccountPriority(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
  priority: number,
): { ok: boolean } {
  const accounts = getAccounts(config, p);
  if (!accounts.some((a) => a.id === id)) return { ok: false };
  setAccounts(
    config,
    p,
    accounts.map((a) => (a.id === id ? { ...a, priority } : a)),
  );
  return { ok: true };
}

/**
 * Set (or CLEAR, with `undefined`) one account's per-account proxy override by id
 * (upstream-proxy). Entry-metadata only — the token mirror is unaffected, so no
 * `deriveMirror`. The `proxy.password` is encrypted at rest by the tokens
 * `SecretBox` walker on persist. Rejects an unknown id.
 */
export function setAccountProxy(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
  proxy: ProxyConfig | undefined,
): { ok: boolean } {
  const accounts = getAccounts(config, p);
  if (!accounts.some((a) => a.id === id)) return { ok: false };
  setAccounts(
    config,
    p,
    accounts.map((a) => {
      if (a.id !== id) return a;
      if (!proxy) {
        const { proxy: _drop, ...rest } = a;
        return rest;
      }
      return { ...a, proxy };
    }),
  );
  return { ok: true };
}

/**
 * Set one account's `lastUsedAt` by id (subscription-account-scheduling, best-
 * effort LRU persist). Entry-metadata only — the token mirror is unaffected.
 * Rejects an unknown id.
 */
export function setAccountLastUsed(
  config: AccountTokensConfig,
  p: DaemonProvider,
  id: string,
  iso: string,
): { ok: boolean } {
  const accounts = getAccounts(config, p);
  if (!accounts.some((a) => a.id === id)) return { ok: false };
  setAccounts(
    config,
    p,
    accounts.map((a) => (a.id === id ? { ...a, lastUsedAt: iso } : a)),
  );
  return { ok: true };
}

/** Remove a provider entirely (accounts + active id + mirror). */
export function clearProvider(config: AccountTokensConfig, p: DaemonProvider): void {
  setBlock(config, p, undefined);
  setAccounts(config, p, undefined);
  setActiveId(config, p, undefined);
}

export const DAEMON_PROVIDER_KEYS = PROVIDER_KEYS;
