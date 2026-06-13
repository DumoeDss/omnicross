/**
 * accountsAdapter.ts — the daemon ⇄ Accounts page adapter (design D2/D3).
 *
 * SECRET SPINE (the load-bearing invariant): the token flows IN via the write
 * body and NEVER OUT. `writeTokens` builds the body FIELD-BY-FIELD from the
 * per-provider allowlist (deny-by-default — never spreads arbitrary keys),
 * mirroring `llmConfigAdapter.fromClientInput`. The daemon's `validateTokenBody`
 * 400s on any field outside its allowlist (e.g. opencodego is manual-only;
 * gemini rejects `setupTokenExpiresAt`), so the form constrains authMethod/status
 * per provider; on failure the daemon's 400 message is surfaced honestly.
 *
 * The write RESPONSE is parsed as the sanitized status only (`SubscriptionListEntry`)
 * — the submitted token never round-trips. `startOAuth`/`completeOAuth` drive the
 * daemon's two-phase interactive OAuth login (claude/gemini): `start` returns the
 * public authorize URL + an opaque sessionId; `complete` submits the pasted code
 * and parses ONLY the sanitized status (never the minted token).
 */

import { adminClient } from './adminClient';
import type {
  AgentAccountsApi,
  CodexOAuthStatus,
  MutationResult,
  RefreshResult,
  StartOAuthResult,
  WriteTokensResult,
} from './types';
import type {
  AccountsListResponse,
  AccountTokenInput,
  ClaudeTokenInput,
  CodexTokenInput,
  GeminiTokenInput,
  OpenCodeGoTokenInput,
  SubscriptionListEntry,
  SubscriptionProviderId,
} from './types-accounts';

/** Set a body field only when the value is a non-empty string. */
function setStr(body: Record<string, unknown>, key: string, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) body[key] = value;
}

/** Build the claude write body — only the daemon's claude allowlist. */
function fromClaude(input: ClaudeTokenInput): Record<string, unknown> {
  const body: Record<string, unknown> = { authMethod: input.authMethod, status: input.status };
  if (input.subscriptionLevel) body['subscriptionLevel'] = input.subscriptionLevel;
  setStr(body, 'accessToken', input.accessToken);
  setStr(body, 'refreshToken', input.refreshToken);
  setStr(body, 'expiresAt', input.expiresAt);
  setStr(body, 'setupTokenExpiresAt', input.setupTokenExpiresAt);
  setStr(body, 'lastRefreshedAt', input.lastRefreshedAt);
  setStr(body, 'errorMessage', input.errorMessage);
  if (Array.isArray(input.scopes) && input.scopes.length > 0) body['scopes'] = input.scopes;
  if (typeof input.isSetupToken === 'boolean') body['isSetupToken'] = input.isSetupToken;
  return body;
}

/** Build the codex write body — only the daemon's codex allowlist. */
function fromCodex(input: CodexTokenInput): Record<string, unknown> {
  const body: Record<string, unknown> = { authMethod: input.authMethod, status: input.status };
  setStr(body, 'accessToken', input.accessToken);
  setStr(body, 'refreshToken', input.refreshToken);
  setStr(body, 'idToken', input.idToken);
  setStr(body, 'expiresAt', input.expiresAt);
  setStr(body, 'accountId', input.accountId);
  setStr(body, 'email', input.email);
  setStr(body, 'organizationId', input.organizationId);
  setStr(body, 'lastRefreshedAt', input.lastRefreshedAt);
  setStr(body, 'errorMessage', input.errorMessage);
  return body;
}

/** Build the gemini write body — only the daemon's gemini allowlist. */
function fromGemini(input: GeminiTokenInput): Record<string, unknown> {
  const body: Record<string, unknown> = { authMethod: input.authMethod, status: input.status };
  setStr(body, 'accessToken', input.accessToken);
  setStr(body, 'refreshToken', input.refreshToken);
  setStr(body, 'expiresAt', input.expiresAt);
  setStr(body, 'lastRefreshedAt', input.lastRefreshedAt);
  setStr(body, 'errorMessage', input.errorMessage);
  return body;
}

/** Build the opencodego write body — manual-only; only its allowlist. */
function fromOpenCodeGo(input: OpenCodeGoTokenInput): Record<string, unknown> {
  const body: Record<string, unknown> = { authMethod: 'manual', status: input.status };
  setStr(body, 'apiKey', input.apiKey);
  setStr(body, 'baseUrl', input.baseUrl);
  setStr(body, 'zenBaseUrl', input.zenBaseUrl);
  setStr(body, 'lastRefreshedAt', input.lastRefreshedAt);
  setStr(body, 'errorMessage', input.errorMessage);
  return body;
}

/** Dispatch a write payload to the per-provider field-by-field builder. */
function buildBody(payload: AccountTokenInput): Record<string, unknown> {
  switch (payload.providerId) {
    case 'claude':
      return fromClaude(payload.input);
    case 'codex':
      return fromCodex(payload.input);
    case 'gemini':
      return fromGemini(payload.input);
    case 'opencodego':
      return fromOpenCodeGo(payload.input);
  }
}

export function createAccountsAdapter(): AgentAccountsApi {
  return {
    async list(): Promise<AccountsListResponse> {
      try {
        return await adminClient.get<AccountsListResponse>('/accounts');
      } catch {
        return {
          accounts: [],
          providerAccounts: { claude: [], codex: [], gemini: [], opencodego: [] },
        };
      }
    },

    async writeTokens(payload: AccountTokenInput): Promise<WriteTokensResult> {
      try {
        const body = buildBody(payload);
        // Read back ONLY the sanitized status — never the submitted token.
        const data = await adminClient.put<{ account?: SubscriptionListEntry; ok?: boolean }>(
          `/accounts/${encodeURIComponent(payload.providerId)}`,
          body,
        );
        return { success: true, status: data.account };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to write tokens' };
      }
    },

    async appendTokens(payload: AccountTokenInput, label?: string): Promise<WriteTokensResult> {
      try {
        const body = buildBody(payload);
        if (label && label.length > 0) body['label'] = label;
        // Append + activate; read back ONLY the sanitized status (never the token).
        const data = await adminClient.post<{ account?: SubscriptionListEntry; ok?: boolean }>(
          `/accounts/${encodeURIComponent(payload.providerId)}/accounts`,
          body,
        );
        return { success: true, status: data.account };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to add account' };
      }
    },

    async refreshProvider(providerId: SubscriptionProviderId): Promise<RefreshResult> {
      try {
        // Token-free: the daemon refreshes the active account server-side and
        // returns ONLY { ok, account? } (never a token).
        const data = await adminClient.post<{ ok: boolean; account?: SubscriptionListEntry }>(
          `/accounts/${encodeURIComponent(providerId)}/refresh`,
        );
        return { success: true, ok: data.ok, status: data.account };
      } catch (err) {
        return {
          success: false,
          ok: false,
          message: err instanceof Error ? err.message : 'failed to refresh token',
        };
      }
    },

    async renameAccount(
      providerId: SubscriptionProviderId,
      accountId: string,
      label: string,
    ): Promise<MutationResult> {
      try {
        await adminClient.post(
          `/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}/label`,
          { label },
        );
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to rename account' };
      }
    },

    async setActive(providerId: SubscriptionProviderId, id: string): Promise<MutationResult> {
      try {
        await adminClient.put(`/accounts/${encodeURIComponent(providerId)}/active`, { id });
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to set active account' };
      }
    },

    async removeAccount(
      providerId: SubscriptionProviderId,
      accountId: string,
    ): Promise<MutationResult> {
      try {
        await adminClient.delete(
          `/accounts/${encodeURIComponent(providerId)}/${encodeURIComponent(accountId)}`,
        );
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to remove account' };
      }
    },

    async clearProvider(providerId: SubscriptionProviderId): Promise<MutationResult> {
      try {
        await adminClient.delete(`/accounts/${encodeURIComponent(providerId)}`);
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to clear provider' };
      }
    },

    async startOAuth(providerId: SubscriptionProviderId): Promise<StartOAuthResult> {
      // Returns ONLY the public authorize URL + an opaque sessionId (no secret).
      return adminClient.post<StartOAuthResult>(
        `/accounts/${encodeURIComponent(providerId)}/oauth/start`,
      );
    },

    async completeOAuth(
      providerId: SubscriptionProviderId,
      input: { sessionId: string; code: string; label?: string },
    ): Promise<WriteTokensResult> {
      try {
        const body: Record<string, unknown> = { sessionId: input.sessionId, code: input.code };
        if (input.label && input.label.length > 0) body['label'] = input.label;
        // Parse ONLY the sanitized status — the minted token never round-trips.
        const data = await adminClient.post<{ account?: SubscriptionListEntry; ok?: boolean }>(
          `/accounts/${encodeURIComponent(providerId)}/oauth/complete`,
          body,
        );
        return { success: true, status: data.account };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to complete sign-in' };
      }
    },

    async importExternalCli(
      providerId: 'claude' | 'codex',
      label?: string,
    ): Promise<MutationResult> {
      try {
        const body: Record<string, unknown> = {};
        if (label && label.length > 0) body['label'] = label;
        // Daemon-side read + append; the imported credential never crosses the wire.
        await adminClient.post(
          `/accounts/${encodeURIComponent(providerId)}/import-external`,
          body,
        );
        return { success: true };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'failed to import CLI login',
        };
      }
    },

    async pollCodexOAuth(sessionId: string): Promise<CodexOAuthStatus> {
      // Token-free poll: the daemon captures + persists the codex token entirely
      // server-side; this only reads `{ state, message? }` (never a token).
      return adminClient.get<CodexOAuthStatus>(
        `/accounts/codex/oauth/${encodeURIComponent(sessionId)}/status`,
      );
    },
  };
}
