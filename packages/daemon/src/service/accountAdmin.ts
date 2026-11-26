/**
 * accountAdmin — the subscription-account admin SERVICE LAYER.
 *
 * Plain functions returning a {@link ServiceResult}; the daemon's
 * `/admin/api/accounts/*` handlers and the embedding host both call them. The
 * write paths take already-parsed JSON bodies and run the same deny-by-default
 * validators (`admin/accountsWrite`) the HTTP API always used.
 *
 * SECRET SPINE: credentials flow IN (manual add / token write) and NEVER OUT —
 * every response is a sanitized status entry or an ack. Only the narrow writer /
 * appender interfaces are reachable here; no token-returning read is.
 *
 * Import discipline: part of the embed entry's static graph — no imports of
 * `admin/adminApi.ts` or image/search modules.
 *
 * @module @omnicross/daemon/service/accountAdmin
 */

import type { ProxyConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';
import { normalizeProxyConfig } from '@omnicross/core/outbound-api';
import { getSharedAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';

import type { AccountAllowanceAdminReader } from '../admin/accountAllowanceApi';
import type { SubscriptionAccountAppender } from '../admin/accountsOAuth';
import {
  type AccountsStatusReader,
  asSubscriptionProviderId,
  statusEntryFor,
  type SubscriptionTokenWriter,
  validateAccountBatchBody,
  validateAccountMetadataPatch,
  validateSupportedModelsBody,
  validateTokenBody,
} from '../admin/accountsWrite';

import { fail, ok, type ServiceResult } from './result';

/** Secret-free connection probe surface (the daemon's account probe scheduler). */
export interface AccountProbeService {
  getAllHistory(): Array<{ providerId: string; accountId: string; records: unknown[] }>;
  testAccountConnection(
    providerId: SubscriptionProviderId,
    accountId: string,
  ): Promise<{ ok: boolean; marked: boolean; tier: 'local' | 'upstream' | 'generation'; model?: string }>;
}

/** The live handles the account service operates over. */
export interface AccountAdminDeps {
  /** Token-free account listing (`SubscriptionAccountService`). */
  readonly subscriptionAccounts: AccountsStatusReader;
  /** Least-authority token WRITER (no token-returning read). */
  readonly subscriptionTokenWriter: SubscriptionTokenWriter;
  /** Narrow multi-account append handle. */
  readonly subscriptionAccountAppender: SubscriptionAccountAppender;
  /** Optional allowance cache (snapshot cleanup + diagnostics history). */
  readonly accountAllowanceService?: Pick<
    AccountAllowanceAdminReader,
    'removeAccountSnapshot' | 'removeProviderSnapshots' | 'getSchedulingStatus'
  >;
  /** Optional connection probe (absent ⇒ `test` answers 501). */
  readonly accountProbeService?: Pick<AccountProbeService, 'getAllHistory' | 'testAccountConnection'>;
}

function unknownProvider(raw: string | undefined): ServiceResult {
  return fail(400, `unknown subscription provider '${raw ?? ''}'`);
}

async function accountExists(
  deps: AccountAdminDeps,
  providerId: SubscriptionProviderId,
  accountId: string,
): Promise<boolean> {
  const listed = await deps.subscriptionTokenWriter.listSanitizedAccounts();
  return (listed[providerId] ?? []).some((account) => account.id === accountId);
}

function optionalLabel(body: Record<string, unknown>): string | undefined {
  return typeof body['label'] === 'string' && body['label'].trim() ? body['label'].trim() : undefined;
}

/**
 * `GET /accounts` → token-free list + sanitized per-provider accounts arrays
 * (id/label/status/expiresAt/hasAccessToken/isActive only, NEVER a raw token or
 * `enc:` envelope) + external CLI login presence booleans.
 */
export async function listAccounts(deps: AccountAdminDeps): Promise<ServiceResult> {
  const accounts = await deps.subscriptionAccounts.listAll();
  const providerAccounts = await deps.subscriptionTokenWriter.listSanitizedAccounts();
  const externalCli = await deps.subscriptionTokenWriter.listExternalCliAvailability();
  return ok(200, { accounts, providerAccounts, externalCli });
}

/** `POST /accounts/batch` — bounded, all-or-nothing management across pools. */
export async function batchAccounts(
  deps: AccountAdminDeps,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const parsed = validateAccountBatchBody(body);
  if (!parsed) return fail(400, 'invalid account batch request');
  const result = await deps.subscriptionTokenWriter.batchManageAccounts(parsed.refs, parsed.mutation);
  if (!result.ok) {
    return fail(
      404,
      `account '${result.missing.accountId}' not found for provider '${result.missing.providerId}'`,
    );
  }
  if (parsed.mutation.action === 'delete') {
    for (const ref of parsed.refs) {
      deps.accountAllowanceService?.removeAccountSnapshot?.(ref.providerId, ref.accountId);
    }
  }
  return ok(200, { ok: true, affected: result.affected });
}

/** `GET /accounts/:providerId/:accountId/diagnostics` — bounded, secret-free. */
export async function accountDiagnostics(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  if (!(await accountExists(deps, providerId, accountId))) {
    return fail(404, `account '${accountId}' not found`);
  }
  const health = getSharedAccountHealth().getDiagnostics({ providerId, accountId });
  const allowance = deps.accountAllowanceService?.getSchedulingStatus?.()?.history
    .filter((entry) => entry.providerId === providerId && entry.accountId === accountId)
    .map((entry) => ({
      kind: 'allowance-policy' as const,
      at: Date.parse(entry.decidedAt),
      providerId: entry.providerId,
      accountId: entry.accountId,
      action: entry.action,
      reason: entry.reason,
      usedPercent: entry.usedPercent,
      resumeAt: entry.resumeAt,
    })) ?? [];
  const diagnostics = [...health, ...allowance]
    .sort((left, right) => right.at - left.at)
    .slice(0, 200);
  return ok(200, { diagnostics });
}

/** `GET /accounts/:providerId/:accountId/events` — bounded probe history. */
export async function accountEvents(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  if (!(await accountExists(deps, providerId, accountId))) {
    return fail(404, `account '${accountId}' not found`);
  }
  const snapshot = deps.accountProbeService?.getAllHistory()
    .find((entry) => entry.providerId === providerId && entry.accountId === accountId);
  const diagnostics = getSharedAccountHealth().getDiagnostics({ providerId, accountId });
  return ok(200, { events: snapshot?.records ?? [], diagnostics });
}

/**
 * `PATCH /accounts/:providerId/:accountId` — consolidated non-secret metadata
 * (label / enabled / priority / group / tags …). Deny-by-default validation
 * rejects token-like or unknown fields.
 */
export async function patchAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const patch = validateAccountMetadataPatch(body);
  if (!patch) return fail(400, 'invalid account metadata patch');
  const result = await deps.subscriptionTokenWriter.patchAccountMetadata(providerId, accountId, patch);
  if (!result.ok) return fail(404, `account '${accountId}' not found`);
  return ok(200, { ok: true });
}

/**
 * `POST /accounts/:providerId/accounts` → APPEND a new account (manual add) from
 * a validated token block (+ optional `label`). Always appends + activates.
 */
export async function addManualAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const block = validateTokenBody(providerId, body);
  if (!block) return fail(400, `malformed token body for provider '${providerId}'`);
  await deps.subscriptionAccountAppender.appendProviderAccount(providerId, block, optionalLabel(body));
  const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
  return ok(200, status ? { account: status } : { ok: true });
}

/**
 * `POST /accounts/:providerId/import-external` → copy the external CLI's current
 * login into a NEW account (claude/codex only). The native credential file stays
 * unmanaged. STATUS-ONLY response.
 *
 * `productName` names the importing product in the response message (the
 * daemon passes its own name; an embedding host passes its own or nothing).
 */
export async function importExternalAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown>,
  productName = 'Omnicross',
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  if (providerId !== 'claude' && providerId !== 'codex') {
    return fail(400, `provider '${providerId}' has no external CLI store`);
  }
  const result = await deps.subscriptionTokenWriter.importExternalCliAccount(providerId, optionalLabel(body));
  if (!result.ok) return fail(409, `no usable external ${providerId} CLI credential found`);
  const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
  return ok(200, {
    ok: true,
    account: status ?? undefined,
    nativeCredentialMode: result.nativeCredentialMode,
    refreshWritesNativeCredentials: result.refreshWritesNativeCredentials,
    message:
      `Imported a read-only copy. ${productName} does not manage the native CLI credential file and future refreshes do not write it.`,
  });
}

/**
 * `POST /accounts/:providerId/refresh` → refresh the ACTIVE account's OAuth
 * token. opencodego is a static key → 400. Honest `ok`; never echoes a token.
 */
export async function refreshAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  if (providerId === 'opencodego') return fail(400, 'opencodego credentials are not refreshable');
  const writer = deps.subscriptionTokenWriter;
  const refreshed =
    providerId === 'claude'
      ? await writer.refreshClaudeToken()
      : providerId === 'codex'
        ? await writer.refreshCodexToken()
        : await writer.refreshGeminiToken();
  const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
  return ok(200, { ok: refreshed, account: status ?? undefined });
}

/** `POST /accounts/:providerId/:accountId/test` — manual connection test (may bill). */
export async function testAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  if (!deps.accountProbeService) return fail(501, 'account probe service unavailable');
  if (!(await accountExists(deps, providerId, accountId))) {
    return fail(404, `account '${accountId}' not found`);
  }
  const result = await deps.accountProbeService.testAccountConnection(providerId, accountId);
  return ok(200, { ok: result.ok, marked: result.marked, tier: result.tier, model: result.model });
}

/** `POST /accounts/:providerId/:accountId/label` — rename (label only). */
export async function renameAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const label = typeof body['label'] === 'string' ? body['label'].trim() : '';
  const result = await deps.subscriptionTokenWriter.renameAccount(providerId, accountId, label);
  if (!result.ok) return fail(404, `account '${accountId}' not found`);
  return ok(200, { ok: true });
}

/** `POST /accounts/:providerId/:accountId/priority` — scheduling priority. */
export async function setAccountPriority(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const raw = body['priority'];
  const priority = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(priority)) return fail(400, 'priority must be a finite number');
  const result = await deps.subscriptionTokenWriter.setAccountPriority(providerId, accountId, priority);
  if (!result.ok) return fail(404, `account '${accountId}' not found`);
  return ok(200, { ok: true });
}

/** `POST /accounts/:providerId/:accountId/proxy` — per-account proxy (null clears). */
export async function setAccountProxy(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const rawProxy = body['proxy'];
  let proxy: ProxyConfig | undefined;
  if (rawProxy !== null && rawProxy !== undefined) {
    proxy = normalizeProxyConfig(rawProxy);
    if (!proxy) return fail(400, 'invalid proxy config');
  }
  const result = await deps.subscriptionTokenWriter.setAccountProxy(providerId, accountId, proxy);
  if (!result.ok) return fail(404, `account '${accountId}' not found`);
  return ok(200, { ok: true });
}

/** `POST /accounts/:providerId/:accountId/supported-models` — model support/remap. */
export async function setAccountSupportedModels(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const parsed = validateSupportedModelsBody(body['supportedModels']);
  if (!parsed.ok) return fail(400, 'invalid supportedModels');
  const result = await deps.subscriptionTokenWriter.setAccountSupportedModels(providerId, accountId, parsed.value);
  if (!result.ok) return fail(404, `account '${accountId}' not found`);
  return ok(200, { ok: true });
}

/** `PUT /accounts/:providerId/active` `{ id }` — switch the active account. */
export async function setActiveAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const id = typeof body['id'] === 'string' ? body['id'] : '';
  if (!id) return fail(400, 'active switch requires { id }');
  const result = await deps.subscriptionTokenWriter.setActiveAccount(providerId, id);
  if (!result.ok) return fail(404, `account '${id}' not found`);
  return ok(200, { ok: true });
}

/** `DELETE /accounts/:providerId/:accountId` — remove one account. */
export async function removeAccount(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  accountId: string,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const result = await deps.subscriptionTokenWriter.removeAccount(providerId, accountId);
  if (!result.removed) return fail(404, `account '${accountId}' not found`);
  deps.accountAllowanceService?.removeAccountSnapshot?.(providerId, accountId);
  return ok(200, { ok: true });
}

/** `DELETE /accounts/:providerId` — clear the whole provider block. */
export async function clearProviderAccounts(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  await deps.subscriptionTokenWriter.clearProvider(providerId);
  deps.accountAllowanceService?.removeProviderSnapshots?.(providerId);
  return ok(200, { ok: true });
}

/**
 * `PUT|POST /accounts/:providerId` — REPLACE the provider's active token block
 * (legacy single-account write). STATUS-ONLY response.
 */
export async function writeProviderTokens(
  deps: AccountAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return unknownProvider(rawProviderId);
  const config = validateTokenBody(providerId, body);
  if (!config) return fail(400, `malformed token body for provider '${providerId}'`);
  await deps.subscriptionTokenWriter.writeProviderTokens(providerId, config);
  const status = await statusEntryFor(deps.subscriptionAccounts, providerId);
  return ok(200, status ? { account: status } : { ok: true });
}
