/**
 * oauthAdmin — the interactive sign-in SERVICE LAYER: one dispatcher over the
 * per-provider OAuth flows (`admin/accounts*OAuth.ts`), shared by the daemon's
 * `/admin/api/accounts/:providerId/oauth/*` routes and the embedding host.
 *
 * Three flow kinds:
 *  - `paste-code` (claude, gemini): `start` → the user pastes the code →
 *    `complete`.
 *  - `loopback` (codex :1455, antigravity :51121): `start` arms a one-shot
 *    loopback listener owned by this process; the caller polls `status`.
 *  - `device-code` (kimi, grok, copilot): `start` returns a verification URL +
 *    user code; the caller polls `status`.
 *
 * Session state lives in the in-memory stores passed as deps; only an opaque
 * `sessionId` (plus public authorize data) ever leaves. Tokens land only in the
 * encrypted credential store.
 *
 * @module @omnicross/daemon/service/oauthAdmin
 */

import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

import {
  type AntigravityOAuthDeps,
  handleAntigravityOAuthCancel,
  handleAntigravityOAuthStart,
  handleAntigravityOAuthStatus,
} from '../admin/accountsAntigravityOAuth';
import {
  type CodexOAuthDeps,
  handleCodexOAuthCancel,
  handleCodexOAuthStart,
  handleCodexOAuthStatus,
} from '../admin/accountsCodexOAuth';
import {
  type CopilotOAuthDeps,
  handleCopilotOAuthCancel,
  handleCopilotOAuthStart,
  handleCopilotOAuthStatus,
} from '../admin/accountsCopilotOAuth';
import {
  type GrokOAuthDeps,
  handleGrokOAuthCancel,
  handleGrokOAuthStart,
  handleGrokOAuthStatus,
} from '../admin/accountsGrokOAuth';
import {
  handleKimiOAuthCancel,
  handleKimiOAuthStart,
  handleKimiOAuthStatus,
  type KimiOAuthDeps,
} from '../admin/accountsKimiOAuth';
import { type AccountsOAuthDeps, handleOAuthComplete, handleOAuthStart } from '../admin/accountsOAuth';
import { asSubscriptionProviderId } from '../admin/accountsWrite';

import { fail, type ServiceResult } from './result';

/** How a provider's interactive sign-in completes. */
export type OAuthFlowKind = 'paste-code' | 'loopback' | 'device-code';

const FLOW_KINDS: Readonly<Partial<Record<SubscriptionProviderId, OAuthFlowKind>>> = Object.freeze({
  claude: 'paste-code',
  gemini: 'paste-code',
  codex: 'loopback',
  antigravity: 'loopback',
  kimi: 'device-code',
  grok: 'device-code',
  copilot: 'device-code',
});

/** The flow kind for a provider, or `null` when it has no interactive sign-in. */
export function oauthFlowKind(providerId: string): OAuthFlowKind | null {
  const id = asSubscriptionProviderId(providerId);
  return id ? (FLOW_KINDS[id] ?? null) : null;
}

/** Every flow's deps (the stores + loopback listeners + exchange fetch + appender). */
export type OAuthAdminDeps = AccountsOAuthDeps &
  CodexOAuthDeps &
  KimiOAuthDeps &
  GrokOAuthDeps &
  CopilotOAuthDeps &
  AntigravityOAuthDeps;

/** Providers whose async (loopback / device-code) flows expose status + cancel. */
const POLLED = new Set<SubscriptionProviderId>(['codex', 'kimi', 'grok', 'copilot', 'antigravity']);

/** Whether `status` / `cancel` apply to this provider (the polled flows). */
export function isPolledOAuthProvider(providerId: string): boolean {
  const id = asSubscriptionProviderId(providerId);
  return id !== null && POLLED.has(id);
}

/**
 * Start a sign-in. Paste-code providers answer `{ authUrl, sessionId }`;
 * loopback providers the same (the listener is armed); device-code providers
 * `{ authUrl, userCode, sessionId }`. `body.enterpriseUrl` selects a GitHub
 * Enterprise domain for copilot.
 */
export async function startOAuth(
  deps: OAuthAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown> = {},
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return fail(400, `unknown subscription provider '${rawProviderId ?? ''}'`);
  switch (providerId) {
    case 'codex':
      return handleCodexOAuthStart(deps);
    case 'kimi':
      return handleKimiOAuthStart(deps);
    case 'grok':
      return handleGrokOAuthStart(deps);
    case 'copilot':
      return handleCopilotOAuthStart(deps, body['enterpriseUrl']);
    case 'antigravity':
      return handleAntigravityOAuthStart(deps);
    default:
      return handleOAuthStart(providerId, deps);
  }
}

/** Complete a paste-code sign-in: `body = { sessionId, code, label? }`. */
export async function completeOAuth(
  deps: OAuthAdminDeps,
  rawProviderId: string | undefined,
  body: Record<string, unknown>,
): Promise<ServiceResult> {
  const providerId = asSubscriptionProviderId(rawProviderId);
  if (!providerId) return fail(400, `unknown subscription provider '${rawProviderId ?? ''}'`);
  return handleOAuthComplete(providerId, body, deps);
}

/** Token-free poll of a loopback / device-code sign-in: `{ state, message? }`. */
export function oauthStatus(
  deps: OAuthAdminDeps,
  providerId: string,
  sessionId: string,
): ServiceResult {
  switch (providerId) {
    case 'codex':
      return handleCodexOAuthStatus(sessionId, deps);
    case 'kimi':
      return handleKimiOAuthStatus(sessionId, deps);
    case 'grok':
      return handleGrokOAuthStatus(sessionId, deps);
    case 'copilot':
      return handleCopilotOAuthStatus(sessionId, deps);
    case 'antigravity':
      return handleAntigravityOAuthStatus(sessionId, deps);
    default:
      return fail(400, `oauth status is not available for provider '${providerId}'`);
  }
}

/** Cancel a loopback / device-code sign-in (frees the loopback port). */
export function cancelOAuth(
  deps: OAuthAdminDeps,
  providerId: string,
  sessionId: string,
): ServiceResult {
  switch (providerId) {
    case 'codex':
      return handleCodexOAuthCancel(sessionId, deps);
    case 'kimi':
      return handleKimiOAuthCancel(sessionId, deps);
    case 'grok':
      return handleGrokOAuthCancel(sessionId, deps);
    case 'copilot':
      return handleCopilotOAuthCancel(sessionId, deps);
    case 'antigravity':
      return handleAntigravityOAuthCancel(sessionId, deps);
    default:
      return fail(400, `oauth cancel is not available for provider '${providerId}'`);
  }
}
