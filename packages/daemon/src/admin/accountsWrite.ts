/**
 * accountsWrite — the daemon admin API's subscription-token WRITE path
 * (`PUT|POST|DELETE /admin/api/accounts/:providerId`, design D1/D3/D4/D5).
 *
 * Extracted from `adminApi.ts` (file-size discipline, design D6) so the write
 * handler + the per-provider body validators live in one focused module.
 *
 * SECRET SPINE (the load-bearing invariant): the token flows IN via the POST/PUT
 * body and NEVER OUT. The write/clear response is STATUS-ONLY — the token-free
 * `SubscriptionListEntry` for that provider (or a `{ ok: true }` ack). The handler
 * NEVER serializes the request body (or any token field) back. The least-authority
 * `SubscriptionTokenWriter` dep exposes ONLY `writeProviderTokens` / `clearProvider`,
 * so this layer is structurally unable to read a stored token.
 *
 * @module @omnicross/daemon/admin/accountsWrite
 */

import type {
  ClaudeTokenConfig,
  CodexTokenConfig,
  GeminiTokenConfig,
  SubscriptionAccountSanitized,
  TokenStatus,
} from '@omnicross/contracts/account-tokens-types';
import type {
  OpenCodeGoTokenConfig,
  SubscriptionListEntry,
  SubscriptionProviderId,
} from '@omnicross/contracts/subscription-types';

import type { SubscriptionTokenBlock } from '../ports/JsonSubscriptionCredentialStore';

/**
 * Least-authority writer handle (design D4): the admin write path sees ONLY the
 * mutation methods of the credential store, never a token-returning read. Wired
 * in `bootstrap.ts` from the concrete `daemon.credentialStore`.
 */
export interface SubscriptionTokenWriter {
  writeProviderTokens(providerId: SubscriptionProviderId, config: SubscriptionTokenBlock): Promise<void>;
  clearProvider(providerId: SubscriptionProviderId): Promise<void>;
  // Multi-account management (subscription-multi-account D5/D8). All secret-free:
  // a switch/remove/rename never returns a token; the sanitized list omits all
  // token material. These are daemon-only concrete-store methods, NOT on the port.
  setActiveAccount(providerId: SubscriptionProviderId, id: string): Promise<{ ok: boolean }>;
  removeAccount(providerId: SubscriptionProviderId, id: string): Promise<{ removed: boolean }>;
  /** Rename one account's label (label-only; rejects an unknown id). */
  renameAccount(providerId: SubscriptionProviderId, id: string, label: string): Promise<{ ok: boolean }>;
  /** Set one account's scheduling priority (secret-free; rejects an unknown id).
   *  subscription-account-scheduling — lets an operator order a pool. */
  setAccountPriority(providerId: SubscriptionProviderId, id: string, priority: number): Promise<{ ok: boolean }>;
  listSanitizedAccounts(): Promise<Record<string, SubscriptionAccountSanitized[]>>;
  // Active-account OAuth token refresh (oauth design D4). Each returns an HONEST
  // boolean (false when the active block has no refresh_token, or the upstream
  // refresh failed) and NEVER returns a token. opencodego has no refresh (static).
  refreshClaudeToken(): Promise<boolean>;
  refreshCodexToken(): Promise<boolean>;
  refreshGeminiToken(): Promise<boolean>;
  // External CLI import (external-cli-sync): detection is pure file presence
  // (never a token); import appends + activates a new account and takes managed
  // ownership of the native store so refreshes write back. Both run entirely
  // daemon-side — the credential files live on the daemon's machine.
  listExternalCliAvailability(): Promise<Record<'claude' | 'codex', boolean>>;
  importExternalCliAccount(
    providerId: 'claude' | 'codex',
    label?: string,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: 'no-credential' }>;
}

/** Token-free status reader for the write response (NOT a token-returning surface). */
export interface AccountsStatusReader {
  listAll(): Promise<unknown[]>;
}

const VALID_PROVIDER_IDS: readonly SubscriptionProviderId[] = [
  'claude',
  'codex',
  'gemini',
  'opencodego',
];

/** Narrow a path segment to a known `SubscriptionProviderId` (or `null`). */
export function asSubscriptionProviderId(id: string | undefined): SubscriptionProviderId | null {
  return VALID_PROVIDER_IDS.includes(id as SubscriptionProviderId)
    ? (id as SubscriptionProviderId)
    : null;
}

// ── Per-provider body validators ──────────────────────────────────────────────
//
// Each returns the typed block on a valid shape, or `null` on malformed input
// (→ 400). They REQUIRE `authMethod` + `status` and copy through only the known
// optional fields (no arbitrary keys reach `tokens.json`). The token strings are
// NOT logged or echoed — they are written through the store and dropped here.

const CLAUDE_AUTH_METHODS = new Set(['oauth', 'setup_token', 'manual']);
const OAUTH_AUTH_METHODS = new Set(['oauth', 'manual']);
const TOKEN_STATUSES = new Set<TokenStatus>([
  'unconfigured',
  'authorized',
  'configured',
  'expired',
  'error',
]);
const OPENCODEGO_STATUSES = new Set(['unconfigured', 'configured', 'error']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

function validateClaude(body: Record<string, unknown>): ClaudeTokenConfig | null {
  const authMethod = str(body['authMethod']);
  const status = str(body['status']);
  if (!authMethod || !CLAUDE_AUTH_METHODS.has(authMethod)) return null;
  if (!status || !TOKEN_STATUSES.has(status as TokenStatus)) return null;
  const subscriptionLevel = str(body['subscriptionLevel']);
  const out: ClaudeTokenConfig = {
    authMethod: authMethod as ClaudeTokenConfig['authMethod'],
    status: status as TokenStatus,
  };
  if (subscriptionLevel === 'Free' || subscriptionLevel === 'Pro' || subscriptionLevel === 'Max') {
    out.subscriptionLevel = subscriptionLevel;
  }
  copyOptional(out, body, ['accessToken', 'refreshToken', 'expiresAt', 'setupTokenExpiresAt', 'lastRefreshedAt', 'errorMessage']);
  const scopes = strArr(body['scopes']);
  if (scopes) out.scopes = scopes;
  if (typeof body['isSetupToken'] === 'boolean') out.isSetupToken = body['isSetupToken'];
  return out;
}

function validateCodex(body: Record<string, unknown>): CodexTokenConfig | null {
  const authMethod = str(body['authMethod']);
  const status = str(body['status']);
  if (!authMethod || !OAUTH_AUTH_METHODS.has(authMethod)) return null;
  if (!status || !TOKEN_STATUSES.has(status as TokenStatus)) return null;
  const out: CodexTokenConfig = {
    authMethod: authMethod as CodexTokenConfig['authMethod'],
    status: status as TokenStatus,
  };
  copyOptional(out, body, [
    'accessToken', 'refreshToken', 'idToken', 'expiresAt', 'accountId',
    'email', 'organizationId', 'lastRefreshedAt', 'errorMessage',
  ]);
  return out;
}

function validateGemini(body: Record<string, unknown>): GeminiTokenConfig | null {
  const authMethod = str(body['authMethod']);
  const status = str(body['status']);
  if (!authMethod || !OAUTH_AUTH_METHODS.has(authMethod)) return null;
  if (!status || !TOKEN_STATUSES.has(status as TokenStatus)) return null;
  const out: GeminiTokenConfig = {
    authMethod: authMethod as GeminiTokenConfig['authMethod'],
    status: status as TokenStatus,
  };
  copyOptional(out, body, ['accessToken', 'refreshToken', 'expiresAt', 'lastRefreshedAt', 'errorMessage']);
  return out;
}

function validateOpenCodeGo(body: Record<string, unknown>): OpenCodeGoTokenConfig | null {
  const authMethod = str(body['authMethod']);
  const status = str(body['status']);
  if (authMethod !== 'manual') return null;
  if (!status || !OPENCODEGO_STATUSES.has(status)) return null;
  const out: OpenCodeGoTokenConfig = {
    authMethod: 'manual',
    status: status as OpenCodeGoTokenConfig['status'],
  };
  copyOptional(out, body, ['apiKey', 'baseUrl', 'zenBaseUrl', 'lastRefreshedAt', 'errorMessage']);
  // modelMap / fallbacks are structured passthroughs (object shapes); copy as-is
  // when present (the OpenCodeGo router validates entries at read time).
  if (body['modelMap'] && typeof body['modelMap'] === 'object') {
    out.modelMap = body['modelMap'] as OpenCodeGoTokenConfig['modelMap'];
  }
  if (body['fallbacks'] && typeof body['fallbacks'] === 'object') {
    out.fallbacks = body['fallbacks'] as OpenCodeGoTokenConfig['fallbacks'];
  }
  return out;
}

/** Copy through only the named string fields that are present + string-typed. */
function copyOptional(out: object, body: Record<string, unknown>, keys: string[]): void {
  const sink = out as Record<string, unknown>;
  for (const key of keys) {
    const v = body[key];
    if (typeof v === 'string') sink[key] = v;
  }
}

/** Validate the wire body to the provider's token shape (`null` → 400). */
export function validateTokenBody(
  providerId: SubscriptionProviderId,
  body: Record<string, unknown>,
): SubscriptionTokenBlock | null {
  switch (providerId) {
    case 'claude':
      return validateClaude(body);
    case 'codex':
      return validateCodex(body);
    case 'gemini':
      return validateGemini(body);
    case 'opencodego':
      return validateOpenCodeGo(body);
    default:
      return null;
  }
}

// ── Status-only response projection ───────────────────────────────────────────

/** Build the token-free `SubscriptionListEntry` for one provider (or `null`). */
export async function statusEntryFor(
  reader: AccountsStatusReader,
  providerId: SubscriptionProviderId,
): Promise<SubscriptionListEntry | null> {
  const all = (await reader.listAll()) as SubscriptionListEntry[];
  return all.find((a) => a.providerId === providerId) ?? null;
}
