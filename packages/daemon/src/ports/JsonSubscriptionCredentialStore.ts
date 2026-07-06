/**
 * JsonSubscriptionCredentialStore — the daemon's file-backed
 * `SubscriptionCredentialStore` port impl (design D1).
 *
 * Implements `@omnicross/subscriptions`' narrow six-method credential surface
 * over a sibling `tokens.json` holding an `AccountTokensConfig`-shaped object
 * (`{ claude?, codex?, gemini?, opencodego?, updatedAt }`). Modeled on
 * `JsonOutboundKeyDb`: the constructor takes the path; reads are
 * `existsSync` → `readFileSync` → `JSON.parse`, tolerating a missing/corrupt
 * file by returning a minimal `{ updatedAt }` config (the strategies already
 * guard `?.accessToken`, so a partial/empty config never crashes dispatch).
 *
 * The PORT surface is read-only by design: the codex / gemini strategies pull
 * their access token via `getFullConfig().<provider>.accessToken`; only claude /
 * opencodego have dedicated getters. No OAuth login flow is initiated here
 * (strategies only consume + refresh, never log in).
 *
 * DAEMON-ONLY WRITE PATH (token-paste, design D1): `writeProviderTokens` /
 * `clearProvider` are CONCRETE-CLASS methods — NOT part of the
 * `SubscriptionCredentialStore` port. The registry / auth strategies / account
 * service never see them (they hold the port type), so a mutation can never leak
 * into the subscription block. Only the daemon admin API (which holds the
 * concrete instance via `Daemon.credentialStore`) calls them. They read-merge a
 * single provider block into `tokens.json` and re-persist; since `readConfig`
 * re-reads on every call (NO cache), the next read immediately sees the write.
 *
 * AT-REST ENCRYPTION (secrets design D6/D7): the constructor takes a `SecretBox`.
 * `readConfig` decrypts the token-material fields on read (so every getter +
 * `getFullConfig` returns PLAINTEXT tokens — the subscription bearer path is
 * byte-identical), and `persist` encrypts them before writing. Because EVERY
 * write funnels through `persist`, the OAuth-refresh writes below are encrypted
 * at-rest with NO extra work (the store API guarantees it). The "re-read on every
 * call, no cache" semantics are unchanged.
 *
 * REAL TOKEN REFRESH (oauth design D4): `refresh{Claude,Codex,Gemini}Token` mint
 * a new access token via the shared host-clean OAuth refresh functions
 * (`@omnicross/subscriptions/oauth`, injected `FetchLike` — default global
 * `fetch`), then read-merge the refreshed fields into the provider block and
 * write back through `persist` (→ encrypted). Field-writes:
 * claude/codex write access+refresh(+codex idToken)
 * +expiresAt+status:authorized+lastRefreshedAt; gemini writes ONLY access+
 * expiresAt (its refresh response omits refresh_token → the OLD value is reused,
 * never overwritten). On any failure the block is marked `status:'expired'` +
 * errorMessage and `false` is returned. When the block has NO refresh_token
 * (claude setup-token, manual token), it is an HONEST `false` BEFORE any upstream
 * call — the block is not touched and no refresh_token is invented.
 *
 * @module @omnicross/daemon/ports/JsonSubscriptionCredentialStore
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  AccountTokensConfig,
  ClaudeTokenConfig,
  CodexTokenConfig,
  GeminiTokenConfig,
  ProxyConfig,
  SubscriptionAccountSanitized,
  SyncWarningCode,
} from '@omnicross/contracts/account-tokens-types';
import type {
  OpenCodeGoTokenConfig,
  SubscriptionProviderId,
} from '@omnicross/contracts/subscription-types';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { fetchUpstream } from '@omnicross/core/pipeline/upstreamFetch';

import { preserveProxyConfigSecret } from '../proxy/sanitizeProxy';
import {
  claudeOAuth,
  codexOAuth,
  type FetchLike,
  geminiOAuth,
  type SubscriptionCredentialStore,
} from '@omnicross/subscriptions';

import { decryptTokens, encryptTokens, type SecretBox } from '../secrets';

import * as accountMulti from './account-multi';
import {
  buildImportedTokens,
  buildTokensFromExternal,
  decideExternalImport,
  findDuplicateCredentialIds,
  isExternalDivergent,
} from './account-sync';
import {
  type ExternalCliProvider,
  type ExternalCliReader,
  readExternalCliCredentials,
} from './external-cli-credentials';
import {
  createExternalCliStore,
  type ExternalCliStorePort,
  type ExternalWritableTokens,
} from './external-cli-store';

/**
 * The per-provider token block accepted by `writeProviderTokens`. Mirrors the
 * `AccountTokensConfig` per-provider field types (one of the four contract token
 * shapes), keyed by `SubscriptionProviderId` — the daemon admin layer validates
 * the wire body to one of these before calling the writer.
 */
export type SubscriptionTokenBlock =
  | ClaudeTokenConfig
  | CodexTokenConfig
  | GeminiTokenConfig
  | OpenCodeGoTokenConfig;

/** By-id near-expiry OAuth refresh lead window (mirrors the codex/gemini active
 *  strategy's `REFRESH_LEAD_MS`) — subscription-account-scheduling. */
const ACCOUNT_REFRESH_LEAD_MS = 5 * 60_000;

export class JsonSubscriptionCredentialStore implements SubscriptionCredentialStore {
  /**
   * @param tokensPath  on-disk `tokens.json` location.
   * @param box         at-rest `SecretBox` (encrypt-on-write / decrypt-on-read).
   * @param fetchImpl   OPTIONAL injectable HTTP port for the OAuth refresh
   *                    round-trips (oauth design D4). A TEST-injected transport is
   *                    used verbatim. When ABSENT (production), each refresh uses a
   *                    proxy-aware {@link fetchUpstream} that threads the
   *                    `{ providerId, accountId }` ctx (upstream-proxy M1) so a
   *                    per-account/per-provider proxy is honored on refresh exactly
   *                    as on relay — refresh egresses from the SAME proxy IP as the
   *                    account's traffic. NOT used by any read/write path.
   */
  constructor(
    private readonly tokensPath: string,
    private readonly box: SecretBox,
    private readonly fetchImpl: FetchLike | undefined = undefined,
    /** Injectable external CLI native-store reader (external-cli-sync). */
    private readonly externalCliReader: ExternalCliReader = readExternalCliCredentials,
    /** Injectable external CLI native-store WRITER (marker-gated write-back). */
    private readonly externalCliStore: ExternalCliStorePort = createExternalCliStore(),
  ) {}

  /**
   * The proxy-aware `FetchLike` for one refresh round-trip (upstream-proxy M1). A
   * TEST-injected `fetchImpl` is returned verbatim; otherwise the refresh routes
   * through {@link fetchUpstream} with the account's `{ providerId, accountId }`
   * ctx so the per-account/provider proxy applies. `@internal` — also a test seam.
   */
  buildRefreshFetch(providerId: string, accountId?: string): FetchLike {
    return this.fetchImpl ?? ((url, init) => fetchUpstream(url, init, { providerId, accountId }));
  }

  /**
   * In-flight refresh coalescing (external-cli-sync). OAuth refresh tokens are
   * SINGLE-USE: two concurrent refreshes of one account each spend the same
   * token and the loser bricks a healthy account. Every refresh entry point
   * (auth-strategy lazy refresh, 401 retry, background scheduler) funnels
   * through `coalesce`, so overlapping callers share ONE upstream round-trip.
   */
  private readonly inFlightRefreshes = new Map<string, Promise<boolean>>();

  private coalesce(key: string, task: () => Promise<boolean>): Promise<boolean> {
    const existing = this.inFlightRefreshes.get(key);
    if (existing) return existing;
    const run = task().finally(() => this.inFlightRefreshes.delete(key));
    this.inFlightRefreshes.set(key, run);
    return run;
  }

  /** Full parsed account-tokens config (or a minimal `{ updatedAt }` when the
   *  file is absent/corrupt). This is the hot read — the codex / gemini auth
   *  strategies pull `accessToken` / `expiresAt` / `status` from it. */
  async getFullConfig(): Promise<AccountTokensConfig> {
    return this.readConfig();
  }

  /** Current Claude OAuth access token, or `null` when none is stored. No inline
   *  refresh here — the lead-window / 401-retry refresh is driven by the
   *  subscription auth strategy, which calls `refreshClaudeToken` (now real). */
  async getValidClaudeAccessToken(): Promise<string | null> {
    return this.readConfig().claude?.accessToken ?? null;
  }

  /** Current OpenCodeGo static API key, or `null` when none is stored. */
  async getValidOpenCodeGoApiKey(): Promise<string | null> {
    return this.readConfig().opencodego?.apiKey ?? null;
  }

  /**
   * DAEMON-ONLY per-account proxy lookup by id (upstream-proxy). Returns the
   * DECRYPTED `ProxyConfig` for the account (`readConfig` decrypts on read), or
   * `undefined` for an unknown provider/account or no per-account proxy. Feeds the
   * winning per-account layer of the upstream-proxy resolver. Synchronous like the
   * other hot reads. Never returns token material.
   */
  getAccountProxy(providerId: string, accountId: string): ProxyConfig | undefined {
    if (
      providerId !== 'claude' &&
      providerId !== 'codex' &&
      providerId !== 'gemini' &&
      providerId !== 'opencodego'
    ) {
      return undefined;
    }
    return accountMulti.getAccountProxy(this.readConfig(), providerId, accountId);
  }

  /**
   * DAEMON-ONLY sanitized accounts list (design D8, NOT on the port). Projects
   * each provider's accounts to the secret-free `SubscriptionAccountSanitized`
   * shape (id/label/status/expiresAt/hasAccessToken/isActive) — NEVER a token.
   * Used by the admin accounts GET (secret-IN-never-OUT).
   */
  async listSanitizedAccounts(): Promise<Record<string, SubscriptionAccountSanitized[]>> {
    const config = this.readConfig();
    const health = getSharedAccountHealth();
    const now = Date.now();
    const out: Record<string, SubscriptionAccountSanitized[]> = {};
    for (const provider of ['claude', 'codex', 'gemini', 'opencodego'] as const) {
      const sanitized = accountMulti.sanitizeAccounts(config, provider);
      if (sanitized.length === 0) continue;
      // Attach the live (in-memory) scheduling-health state so the admin accounts
      // view can render "rate-limited until …" (subscription-account-health, 6.1).
      for (const account of sanitized) {
        const status = health.getStatus(provider, account.id, now);
        account.health = status.state;
        account.cooldownUntil =
          status.cooldownUntil !== undefined ? new Date(status.cooldownUntil).toISOString() : undefined;
      }
      out[provider] = this.attachSyncWarnings(config, provider, sanitized);
    }
    return out;
  }

  /**
   * List-time credential-conflict warnings (external-cli-sync). Computed, not
   * persisted: (a) `duplicate-token` when two accounts of one provider share a
   * credential, (b) `external-divergent` when the external CLI native store has
   * rotated PAST the ACTIVE account (claude/codex only). A warning persisted by
   * a failed refresh (`external-not-rotated`) takes precedence — it is the most
   * actionable state.
   */
  private attachSyncWarnings(
    config: AccountTokensConfig,
    provider: 'claude' | 'codex' | 'gemini' | 'opencodego',
    sanitized: SubscriptionAccountSanitized[],
  ): SubscriptionAccountSanitized[] {
    const duplicates = findDuplicateCredentialIds(accountMulti.listAccounts(config, provider));
    let divergentId: string | undefined;
    if (provider === 'claude' || provider === 'codex') {
      const active = accountMulti.getActiveAccount(config, provider);
      if (active && isExternalDivergent(active.tokens, this.safeReadExternal(provider))) {
        divergentId = active.id;
      }
    }
    if (duplicates.size === 0 && !divergentId) return sanitized;
    return sanitized.map((account) => {
      const computed: SyncWarningCode | undefined =
        account.id === divergentId
          ? 'external-divergent'
          : duplicates.has(account.id)
            ? 'duplicate-token'
            : undefined;
      return { ...account, syncWarning: account.syncWarning ?? computed };
    });
  }

  /** Read the external CLI store, never letting an fs/parse error escape. */
  private safeReadExternal(provider: ExternalCliProvider) {
    try {
      return this.externalCliReader(provider);
    } catch {
      return null;
    }
  }

  /**
   * Refresh the Claude OAuth access token (oauth design D4). HONEST `false` when
   * the block has no refresh_token (setup-token / manual) — no upstream call, the
   * block is untouched. Otherwise mint via the shared claude refresh flow and
   * write back access+refresh+expiresAt+status:authorized+lastRefreshedAt.
   * On failure → status:expired +
   * errorMessage → `false`.
   */
  async refreshClaudeToken(): Promise<boolean> {
    return this.coalesce('claude:active', async () => {
      // Capture the active account + id AT READ TIME (oauth design D4).
      const config = this.readConfig();
      const active = accountMulti.getActiveAccount(config, 'claude');
      const claude = active?.tokens as ClaudeTokenConfig | undefined;
      if (!active || !claude?.refreshToken) return false;
      const capturedId = active.id;
      // Materialize a freshly-synthesized account id to disk so the write-back
      // (which re-reads) keys against the SAME, now-durable id (D3 lazy migration).
      this.materializeMigration(config);

      const refreshFetch = this.buildRefreshFetch('claude', capturedId);
      try {
        const result = await claudeOAuth.refreshAccessToken(claude.refreshToken, refreshFetch);
        const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
        const next: ClaudeTokenConfig = {
          ...claude,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt,
          status: 'authorized',
          lastRefreshedAt: new Date().toISOString(),
          errorMessage: undefined,
          syncWarning: undefined,
        };
        this.writeBackById('claude', capturedId, next);
        this.resyncExternal('claude', capturedId, next);
        return true;
      } catch (error) {
        // The refresh may have failed because the external claude CLI already
        // rotated our refresh token in `~/.claude/.credentials.json`
        // (external-cli-sync) — recover by importing the rotated credential.
        if (
          await this.tryExternalImport('claude', capturedId, claude, async (rt) => {
            const r = await claudeOAuth.refreshAccessToken(rt, refreshFetch);
            return {
              accessToken: r.accessToken,
              refreshToken: r.refreshToken,
              expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
            };
          })
        ) {
          return true;
        }
        this.markExpiredById('claude', capturedId, claude, error);
        return false;
      }
    });
  }

  /**
   * Refresh the Codex (ChatGPT) OAuth access token. Same shape
   * as claude, additionally writing back the refreshed `idToken`.
   * HONEST `false` when no refresh_token.
   */
  async refreshCodexToken(): Promise<boolean> {
    return this.coalesce('codex:active', async () => {
      const config = this.readConfig();
      const active = accountMulti.getActiveAccount(config, 'codex');
      const codex = active?.tokens as CodexTokenConfig | undefined;
      if (!active || !codex?.refreshToken) return false;
      const capturedId = active.id;
      this.materializeMigration(config);

      const refreshFetch = this.buildRefreshFetch('codex', capturedId);
      try {
        const result = await codexOAuth.refreshAccessToken(codex.refreshToken, refreshFetch);
        const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
        const next: CodexTokenConfig = {
          ...codex,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          idToken: result.idToken,
          expiresAt,
          status: 'authorized',
          lastRefreshedAt: new Date().toISOString(),
          errorMessage: undefined,
          syncWarning: undefined,
        };
        this.writeBackById('codex', capturedId, next);
        this.resyncExternal('codex', capturedId, next);
        return true;
      } catch (error) {
        // The codex CLI may have rotated the refresh token in
        // `~/.codex/auth.json` (external-cli-sync) — recover via import.
        if (
          await this.tryExternalImport('codex', capturedId, codex, async (rt) => {
            const r = await codexOAuth.refreshAccessToken(rt, refreshFetch);
            return {
              accessToken: r.accessToken,
              refreshToken: r.refreshToken,
              idToken: r.idToken,
              expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
            };
          })
        ) {
          return true;
        }
        this.markExpiredById('codex', capturedId, codex, error);
        return false;
      }
    });
  }

  /**
   * Refresh the Gemini (Google) OAuth access token. The Google
   * refresh response does NOT return a refresh_token, so this writes ONLY
   * access+expiresAt (+status/lastRefreshedAt) and DELIBERATELY leaves the
   * existing `refreshToken` untouched (overwriting it with `undefined` would
   * destroy the ability to refresh again). HONEST `false` when no refresh_token.
   */
  async refreshGeminiToken(): Promise<boolean> {
    return this.coalesce('gemini:active', async () => {
      const config = this.readConfig();
      const active = accountMulti.getActiveAccount(config, 'gemini');
      const gemini = active?.tokens as GeminiTokenConfig | undefined;
      if (!active || !gemini?.refreshToken) return false;
      const capturedId = active.id;
      this.materializeMigration(config);

      const refreshFetch = this.buildRefreshFetch('gemini', capturedId);
      try {
        const result = await geminiOAuth.refreshAccessToken(gemini.refreshToken, refreshFetch);
        const expiresAt = new Date(Date.now() + result.expiresIn * 1000).toISOString();
        const next: GeminiTokenConfig = {
          ...gemini, // KEEP the existing refreshToken (response omits it).
          accessToken: result.accessToken,
          expiresAt,
          status: 'authorized',
          lastRefreshedAt: new Date().toISOString(),
          errorMessage: undefined,
        };
        this.writeBackById('gemini', capturedId, next);
        return true;
      } catch (error) {
        this.markExpiredById('gemini', capturedId, gemini, error);
        return false;
      }
    });
  }

  /**
   * Refresh a SPECIFIC account by id (background scheduler sweep,
   * external-cli-sync). Unlike the active-account refreshers it does NOT
   * attempt the external-import fallback — the external CLI file's lineage can
   * only plausibly match the ACTIVE account. Coalesced per `provider:id`; on
   * failure flags ONLY that account `expired`.
   */
  async refreshAccountById(provider: 'claude' | 'codex' | 'gemini', id: string): Promise<boolean> {
    return this.coalesce(`${provider}:${id}`, async () => {
      const config = this.readConfig();
      const account = accountMulti.getAccountById(config, provider, id);
      const captured = account?.tokens as
        | (ClaudeTokenConfig | CodexTokenConfig | GeminiTokenConfig)
        | undefined;
      if (!account || !captured?.refreshToken) return false;
      this.materializeMigration(config);

      try {
        // upstream-proxy M1: thread the account id so the by-id refresh egresses
        // through THIS account's proxy (residential-IP isolation holds on refresh).
        const refreshed = await this.refreshUpstream(provider, captured.refreshToken, id);
        const next = {
          ...captured,
          accessToken: refreshed.accessToken,
          // Gemini's refresh response omits a new refresh token — keep the captured.
          refreshToken: refreshed.refreshToken ?? captured.refreshToken,
          expiresAt: refreshed.expiresAt,
          status: 'authorized',
          lastRefreshedAt: new Date().toISOString(),
          errorMessage: undefined,
          syncWarning: undefined,
        } as ClaudeTokenConfig | CodexTokenConfig | GeminiTokenConfig;
        if (refreshed.idToken) (next as CodexTokenConfig).idToken = refreshed.idToken;
        this.writeBackById(provider, id, next);
        if (provider !== 'gemini') this.resyncExternal(provider, id, next as ExternalWritableTokens);
        return true;
      } catch (error) {
        this.markExpiredById(provider, id, captured, error);
        return false;
      }
    });
  }

  // ── By-id account-pool surface (subscription-account-scheduling, design D6) ──

  /**
   * Resolve a SPECIFIC account's access token by id (design D6). Mirrors each
   * provider's ACTIVE-getter policy, keyed by id: claude returns the stored token
   * (refresh is 401-driven, like `getValidClaudeAccessToken`); codex/gemini refresh
   * a near-expiry token via `refreshAccountById` (like `resolveAccessToken`);
   * opencodego returns the account's static key. `null` when unknown/expired/
   * tokenless.
   */
  async getAccessTokenForAccount(
    providerId: SubscriptionProviderId,
    accountId: string,
  ): Promise<string | null> {
    const account = accountMulti.getAccountById(this.readConfig(), providerId, accountId);
    if (!account) return null;
    if (providerId === 'opencodego') {
      return (account.tokens as OpenCodeGoTokenConfig).apiKey ?? null;
    }
    const oauth = account.tokens as ClaudeTokenConfig | CodexTokenConfig | GeminiTokenConfig;
    if (!oauth.accessToken) return null;
    if (providerId === 'codex' || providerId === 'gemini') {
      const expiresAtMs = oauth.expiresAt ? Date.parse(oauth.expiresAt) : 0;
      const expiringSoon = expiresAtMs > 0 && Date.now() >= expiresAtMs - ACCOUNT_REFRESH_LEAD_MS;
      if (expiringSoon && oauth.refreshToken) {
        const ok = await this.refreshAccountById(providerId, accountId);
        if (!ok) return null;
        const fresh = accountMulti.getAccountById(this.readConfig(), providerId, accountId);
        return (fresh?.tokens as CodexTokenConfig | GeminiTokenConfig | undefined)?.accessToken ?? null;
      }
    }
    if (oauth.status === 'expired') return null;
    return oauth.accessToken;
  }

  /**
   * Refresh a SPECIFIC account's OAuth token by id (design D6/D7). Delegates to
   * `refreshAccountById` (coalesced per `provider:id`); opencodego is a static key
   * → `false` (no refresh affordance).
   */
  async refreshAccountToken(providerId: SubscriptionProviderId, accountId: string): Promise<boolean> {
    if (providerId === 'opencodego') return false;
    return this.refreshAccountById(providerId, accountId);
  }

  /**
   * Best-effort record of a selection time onto the account's `lastUsedAt` by id
   * (design D4). Entry-metadata only (the token mirror is untouched); a no-op for
   * an unknown id. The selector throttles the call frequency, so this stays cheap.
   */
  async touchAccountLastUsed(
    providerId: SubscriptionProviderId,
    accountId: string,
    iso: string,
  ): Promise<void> {
    const config = this.readConfig();
    const result = accountMulti.setAccountLastUsed(config, providerId, accountId, iso);
    if (!result.ok) return;
    this.persist({ ...config, updatedAt: new Date().toISOString() });
  }

  /**
   * DAEMON-ONLY set-priority (subscription-account-scheduling, admin write, NOT on
   * the port). Set one account's scheduling `priority` by id. Secret-free
   * (entry-metadata only; the mirror invariant is untouched). Rejects an unknown id.
   */
  async setAccountPriority(
    providerId: SubscriptionProviderId,
    accountId: string,
    priority: number,
  ): Promise<{ ok: boolean }> {
    const config = this.readConfig();
    const result = accountMulti.setAccountPriority(config, providerId, accountId, priority);
    if (!result.ok) return result;
    this.persist({ ...config, updatedAt: new Date().toISOString() });
    return result;
  }

  /**
   * DAEMON-ONLY set/clear per-account proxy (upstream-proxy, admin write, NOT on
   * the port). Passing `undefined` clears the override. Write-only password: when
   * the incoming structured proxy omits the password but the account already had
   * one, the current (decrypted) password is preserved — editing host/port never
   * wipes the secret. Persist re-encrypts `proxy.password` via the tokens SecretBox.
   */
  async setAccountProxy(
    providerId: SubscriptionProviderId,
    accountId: string,
    proxy: ProxyConfig | undefined,
  ): Promise<{ ok: boolean }> {
    const config = this.readConfig();
    const merged = proxy
      ? preserveProxyConfigSecret(proxy, accountMulti.getAccountProxy(config, providerId, accountId))
      : undefined;
    const result = accountMulti.setAccountProxy(config, providerId, accountId, merged);
    if (!result.ok) return result;
    this.persist({ ...config, updatedAt: new Date().toISOString() });
    return result;
  }

  /** Dispatch one OAuth refresh round-trip to the provider's shared flow. */
  private async refreshUpstream(
    provider: 'claude' | 'codex' | 'gemini',
    refreshToken: string,
    accountId?: string,
  ): Promise<{ accessToken: string; refreshToken?: string; idToken?: string; expiresAt: string }> {
    const flow =
      provider === 'claude' ? claudeOAuth : provider === 'codex' ? codexOAuth : geminiOAuth;
    // upstream-proxy M1: thread the account ctx so refresh honors the per-account proxy.
    const r = await flow.refreshAccessToken(refreshToken, this.buildRefreshFetch(provider, accountId));
    return {
      accessToken: r.accessToken,
      refreshToken: (r as { refreshToken?: string }).refreshToken,
      idToken: (r as { idToken?: string }).idToken,
      expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
    };
  }

  /**
   * External-import fallback for a FAILED active-account refresh
   * (external-cli-sync). Reads the CLI native store; imports when the external
   * lineage ROTATED (different refresh token) or its access token is still
   * valid. When the imported access token is already expired it refreshes once
   * with the rotated refresh token. A `not-rotated` outcome persists the
   * `external-not-rotated` warning on the (about-to-be-expired) account so the
   * UI can tell "genuine revocation" apart from a plain refresh failure.
   */
  private async tryExternalImport(
    provider: ExternalCliProvider,
    capturedId: string,
    captured: ClaudeTokenConfig | CodexTokenConfig,
    refreshWithToken: (
      refreshToken: string,
    ) => Promise<{ accessToken: string; refreshToken?: string; idToken?: string; expiresAt: string }>,
  ): Promise<boolean> {
    // Lineage guard (external-cli-sync write-back): a marker naming a DIFFERENT
    // account blocks the silent recovery — never cross-contaminate accounts.
    const markerOwner = this.safeReadMarker(provider);
    if (markerOwner && markerOwner !== capturedId) return false;
    const external = this.safeReadExternal(provider);
    const decision = decideExternalImport(captured, external);
    if (decision === 'not-rotated') {
      // Remember WHY for the account list; the caller still flags `expired`.
      (captured as { syncWarning?: SyncWarningCode }).syncWarning = 'external-not-rotated';
      return false;
    }
    if (decision !== 'import' || !external) return false;

    let imported = buildImportedTokens(
      captured as accountMulti.AnyTokenConfig,
      external,
    ) as ClaudeTokenConfig | CodexTokenConfig;
    const accessStillValid = external.expiresAt
      ? Date.parse(external.expiresAt) > Date.now() + 60_000
      : true;
    if (!accessStillValid) {
      // Imported access token already expired, but the refresh token rotated
      // (decideExternalImport guarantees it here) — refresh once with it.
      try {
        const refreshed = await refreshWithToken(external.refreshToken as string);
        imported = {
          ...imported,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? imported.refreshToken,
          expiresAt: refreshed.expiresAt,
          lastRefreshedAt: new Date().toISOString(),
        };
        if (refreshed.idToken) (imported as CodexTokenConfig).idToken = refreshed.idToken;
      } catch {
        return false; // rotated token also dead → genuine failure
      }
    }
    this.writeBackById(provider, capturedId, imported);
    // The refresh-once branch minted a NEWER credential than the file holds —
    // push it back so the CLI is not left with the now-rotated-out token.
    this.resyncExternal(provider, capturedId, imported);
    return true;
  }

  /**
   * Marker-gated external write-back (external-cli-sync). After a successful
   * refresh of the account that OWNS the provider's native CLI store (imported
   * via `importExternalCliAccount`), push the rotated credential back into the
   * file — otherwise the daemon's refresh invalidates the single-use refresh
   * token and silently logs the bare CLI out. NON-FATAL: the internal store is
   * already persisted; a failed external write only leaves the file stale,
   * which the `external-divergent` warning surfaces.
   */
  private resyncExternal(
    provider: ExternalCliProvider,
    accountId: string,
    tokens: ExternalWritableTokens,
  ): void {
    try {
      this.externalCliStore.writeBack(provider, accountId, tokens);
    } catch {
      /* non-fatal — see docstring */
    }
  }

  /** Read the marker's owning account id, never letting an fs error escape. */
  private safeReadMarker(provider: ExternalCliProvider): string | undefined {
    try {
      return this.externalCliStore.readMarkerAccountId(provider);
    } catch {
      return undefined;
    }
  }

  /**
   * DAEMON-ONLY (admin import button): which providers have a usable external
   * CLI credential on THIS machine. Pure detection — reads the native files,
   * never mutates anything, never returns a token.
   */
  async listExternalCliAvailability(): Promise<Record<ExternalCliProvider, boolean>> {
    return {
      claude: Boolean(this.safeReadExternal('claude')?.accessToken),
      codex: Boolean(this.safeReadExternal('codex')?.accessToken),
    };
  }

  /**
   * DAEMON-ONLY (admin import button): import the external CLI's current login
   * as a NEW account (+ activate), and take MANAGED ownership of the native
   * store (marker) so subsequent refreshes write back — keeping the bare CLI
   * and the daemon on the same live credential instead of silently killing one
   * side's single-use refresh token.
   */
  async importExternalCliAccount(
    provider: ExternalCliProvider,
    label?: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'no-credential' }> {
    const external = this.safeReadExternal(provider);
    if (!external?.accessToken) return { ok: false, reason: 'no-credential' };

    const tokens = buildTokensFromExternal(provider, external);
    const result = await this.appendProviderAccount(provider, tokens, label);
    try {
      this.externalCliStore.writeMarker(provider, result.id);
    } catch {
      /* marker write failure only disables future write-back; import stands */
    }
    return { ok: true, id: result.id };
  }

  /**
   * Materialize a lazily-synthesized account id to disk (design D3). On a legacy
   * single-slot file, `readConfig` synthesizes a NON-deterministic account id
   * per read; without persisting it, the later write-back (which re-reads) would
   * synthesize a DIFFERENT id and miss the captured account. Persisting the
   * migrated config here makes the id durable so the write-back keys correctly.
   * Idempotent: a config whose ids are already on disk re-persists byte-equal.
   */
  private materializeMigration(migrated: AccountTokensConfig): void {
    this.persist(migrated);
  }

  /**
   * Write refreshed tokens back to the captured account by id (oauth design D4),
   * re-derive the mirror from the CURRENT active id, re-stamp + persist. A switch
   * mid-refresh leaves the refreshed tokens in the captured (now non-active)
   * account and keeps the CURRENT active account's tokens in the mirror.
   */
  private writeBackById(
    providerId: 'claude' | 'codex' | 'gemini',
    capturedId: string,
    block: ClaudeTokenConfig | CodexTokenConfig | GeminiTokenConfig,
  ): void {
    const config = this.readConfig();
    accountMulti.writeBackRefreshById(config, providerId, capturedId, block);
    this.persist({ ...config, updatedAt: new Date().toISOString() });
  }

  /**
   * Mark the captured account `status:'expired'` + errorMessage on a refresh
   * failure, keyed by id, then re-derive the mirror.
   */
  private markExpiredById(
    providerId: 'claude' | 'codex' | 'gemini',
    capturedId: string,
    block: ClaudeTokenConfig | CodexTokenConfig | GeminiTokenConfig,
    error: unknown,
  ): void {
    const errorMessage = error instanceof Error ? error.message : 'Refresh failed';
    this.writeBackById(providerId, capturedId, {
      ...block,
      status: 'expired',
      errorMessage,
    });
  }

  /**
   * DAEMON-ONLY WRITE (design D1, NOT on the port). Read-merge the given
   * provider's token block into the current `AccountTokensConfig`, stamp a fresh
   * `updatedAt`, and re-persist `tokens.json` as pretty JSON. Preserves every
   * OTHER provider's existing block (read-merge-write, not overwrite). Reuses the
   * tolerate-on-read base (`{ updatedAt: '' }` when the file is absent/corrupt),
   * so a first-ever write still produces a valid config. No cache → the next read
   * sees this write.
   */
  async writeProviderTokens(
    providerId: SubscriptionProviderId,
    config: SubscriptionTokenBlock,
  ): Promise<void> {
    const current = this.readConfig();
    // Update the ACTIVE account (or append + activate a first account when none
    // exists), then re-derive the top-level mirror (D5 token-paste parity).
    accountMulti.writeActiveTokens(current, providerId, config);
    this.persist({ ...current, updatedAt: new Date().toISOString() });
  }

  /**
   * DAEMON-ONLY login append (design D5, NOT on the port). Append a NEW account
   * (optional label) and set it active, then re-derive the mirror — used by
   * `omnicross login <provider> --label` to add an account instead of overwriting.
   */
  async appendProviderAccount(
    providerId: SubscriptionProviderId,
    config: SubscriptionTokenBlock,
    label?: string,
  ): Promise<{ id: string }> {
    const current = this.readConfig();
    const result = accountMulti.addAccount(current, providerId, config, label);
    this.persist({ ...current, updatedAt: new Date().toISOString() });
    return result;
  }

  /**
   * DAEMON-ONLY active switch (design D5, NOT on the port). Switch the active
   * account for a provider; rejects an unknown id. Re-derives the mirror.
   */
  async setActiveAccount(
    providerId: SubscriptionProviderId,
    id: string,
  ): Promise<{ ok: boolean }> {
    const current = this.readConfig();
    const result = accountMulti.setActiveAccount(current, providerId, id);
    if (!result.ok) return result;
    this.persist({ ...current, updatedAt: new Date().toISOString() });
    return result;
  }

  /**
   * DAEMON-ONLY per-account remove (design D5, NOT on the port). Remove one
   * account; promote the most-recent remaining on active-removal (or clear the
   * mirror when none remain). Re-derives the mirror.
   */
  async removeAccount(
    providerId: SubscriptionProviderId,
    id: string,
  ): Promise<{ removed: boolean }> {
    const current = this.readConfig();
    const result = accountMulti.removeAccount(current, providerId, id);
    if (!result.removed) return result;
    this.persist({ ...current, updatedAt: new Date().toISOString() });
    return result;
  }

  /**
   * DAEMON-ONLY per-account rename (NOT on the port). Update one account's label;
   * rejects an unknown id. Label-only — no token material is read or written
   * (the secret-free invariant holds).
   */
  async renameAccount(
    providerId: SubscriptionProviderId,
    id: string,
    label: string,
  ): Promise<{ ok: boolean }> {
    const current = this.readConfig();
    const result = accountMulti.renameAccount(current, providerId, id, label);
    if (!result.ok) return result;
    this.persist({ ...current, updatedAt: new Date().toISOString() });
    return result;
  }

  /**
   * DAEMON-ONLY CLEAR (design D1/D3, NOT on the port). Remove a single provider's
   * block from `tokens.json` and re-persist (the strategies already tolerate an
   * absent block). Stamps a fresh `updatedAt`. A no-op-shaped write when the
   * provider was already absent (still re-stamps + persists).
   */
  async clearProvider(providerId: SubscriptionProviderId): Promise<void> {
    const current = this.readConfig();
    // Remove the provider's accounts + active id + top-level mirror (D3).
    accountMulti.clearProvider(current, providerId);
    this.persist({ ...current, updatedAt: new Date().toISOString() });
  }

  /** Write the merged config to disk as pretty JSON (mkdir parent if needed).
   *  Encrypt-on-write: the token-material fields are encrypted (legacy plaintext
   *  → `enc:v1:`; already-`enc:`/`$ENV` untouched) before serializing, so any
   *  write — incl. child 4's future refresh writes — lands encrypted. */
  private persist(config: AccountTokensConfig): void {
    mkdirSync(dirname(this.tokensPath), { recursive: true });
    const encrypted = encryptTokens(config, this.box);
    writeFileSync(this.tokensPath, JSON.stringify(encrypted, null, 2) + '\n', 'utf8');
  }

  /**
   * Read + parse `tokens.json`, tolerating a missing/corrupt file, then DECRYPT
   * the token-material fields so every getter returns plaintext (the
   * subscription bearer path is byte-identical).
   *
   * The fs-read + JSON-parse tolerance is INSIDE the try (a missing or corrupt
   * file → empty `{ updatedAt: '' }`). The DECRYPT runs OUTSIDE the try, so a
   * wrong/missing master key or a tampered `enc:` envelope FAILS FAST with the
   * box's clear, secret-free error (secrets spec "错误密钥 / 篡改的解密失败 UX":
   * SHALL fail-fast, SHALL NOT 静默降级 — a swallowed decrypt would report "no
   * tokens" and silently send the WRONG bearer upstream → 401). Mirrors
   * `config.ts loadConfig`, which decrypts outside its parse try.
   */
  private readConfig(): AccountTokensConfig {
    if (!existsSync(this.tokensPath)) return { updatedAt: '' };
    let parsed: AccountTokensConfig | null;
    try {
      const raw = JSON.parse(readFileSync(this.tokensPath, 'utf8')) as unknown;
      parsed =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AccountTokensConfig) : null;
    } catch {
      parsed = null; // missing/corrupt file → tolerate as empty
    }
    if (!parsed) return { updatedAt: '' };
    // Decrypt OUTSIDE the try → a wrong-key / tampered-envelope failure propagates.
    const decrypted = decryptTokens(parsed, this.box);
    // Lazy, idempotent, read-pure multi-account migration (D3): a legacy
    // single-slot file synthesizes one account in-memory; ids materialize on
    // the next write through `persist`.
    return accountMulti.migrateLazily(decrypted);
  }
}
