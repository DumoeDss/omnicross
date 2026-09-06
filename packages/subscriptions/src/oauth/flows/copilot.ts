/**
 * GitHub Copilot OAuth flow — RFC 8628 device grant against the official
 * Copilot CLI app at `github.com` (scope `read:user`).
 *
 * The minted `ghu_` token is LONG-LIVED: refresh is a LOCAL no-op (access and
 * refresh are the same token; a far-future expiry keeps every generic
 * near-expiry path idle). After the user approves, the flow (a) reads the
 * GitHub identity (`/user` → login + email), (b) discovers the plan-advertised
 * Copilot API endpoint (`api.github.com/copilot_internal/user` →
 * `endpoints.api`), and (c) best-effort sweeps the model roster's
 * `POST /models/{id}/policy {"state":"enabled"}` — the Claude/Grok models are
 * policy-gated until enabled.
 *
 * Every Copilot API request carries the mirrored Copilot CLI identity
 * (`copilot/1.0.82` UA + Editor-Version, Copilot-Integration-Id, Copilot-
 * Harness-Id, Openai-Intent) plus `X-GitHub-Api-Version: 2026-08-01` — without
 * the version header the endpoint serves default-tier context limits only
 * (e.g. 264k instead of 1M). NEVER send the API version header to
 * `api.github.com` REST endpoints (they validate it against the REST
 * vocabulary). Relay traffic is agent-initiated CLI traffic, so the per-request
 * dynamic `X-Initiator: agent` / `X-Interaction-Type: conversation-agent`
 * pair is STATIC here — the same classification the official CLI sends, and
 * the one GitHub bills at a 0 premium multiplier.
 *
 * GitHub Enterprise domains are a follow-up (this flow targets github.com
 * personal accounts; `enterpriseUrl` on the token config still routes
 * inference through `copilot-api.<domain>` when present).
 *
 * @module @omnicross/subscriptions/oauth/flows/copilot
 */

import type { FetchLike } from '../fetchPort';

import { copilotBaseUrl, copilotWireModelIds } from '../../copilot/models';

/** The official Copilot CLI OAuth app (public client). */
export const COPILOT_OAUTH_CONFIG = {
  clientId: 'Ov23ctDVkRmgkPke0Mmm',
  scope: 'read:user',
  deviceEndpoint: 'https://github.com/login/device/code',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
} as const;

/** GitHub's device-poll pacing: each wait scales ×1.2 (×1.4 after slow_down). */
export const COPILOT_POLL_INITIAL_MULTIPLIER = 1.2;
export const COPILOT_POLL_SLOW_DOWN_MULTIPLIER = 1.4;

const COPILOT_CLI_VERSION = '1.0.82';
const COPILOT_CLI_USER_AGENT = `copilot/${COPILOT_CLI_VERSION}`;

/** Headers GitHub's device endpoints expect (the OAuth app's UA). */
const OAUTH_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'copilot-developer-action/0.0.1',
};

/** Headers for `api.github.com` REST/user endpoints (NO Copilot API version). */
export const COPILOT_GITHUB_HEADERS: Record<string, string> = {
  'User-Agent': COPILOT_CLI_USER_AGENT,
};

/**
 * The STATIC Copilot API identity every inference request carries
 * (mirror of the official CLI's request layer).
 */
export const COPILOT_API_HEADERS: Record<string, string> = {
  ...COPILOT_GITHUB_HEADERS,
  'Editor-Version': COPILOT_CLI_USER_AGENT,
  'Copilot-Integration-Id': 'copilot-developer-cli',
  'Copilot-Harness-Id': 'copilot-sdk',
  'Openai-Intent': 'conversation-agent',
  'X-GitHub-Api-Version': '2026-08-01',
  // Agent-initiated CLI traffic — the official CLI's own classification and
  // the 0-premium-multiplier billing tier GitHub defines for it.
  'X-Initiator': 'agent',
  'X-Interaction-Type': 'conversation-agent',
};

/** Far-future expiry (10 years) — ghu_ tokens have no refresh lifecycle. */
export const COPILOT_FAR_FUTURE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

/** Device-authorization response (RFC 8628 §3.2). */
export interface CopilotDeviceAuthorization {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  /** Poll interval in seconds. */
  interval: number;
  /** Lifetime in seconds. */
  expiresIn: number;
}

/** One polled token attempt's outcome. */
export type CopilotDevicePoll =
  | { state: 'pending' }
  | { state: 'slowDown'; intervalSeconds?: number }
  | { state: 'done'; accessToken: string }
  | { state: 'failed'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: URLSearchParams,
  timeoutMs = 30_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: OAUTH_HEADERS,
    body: params.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    body = isRecord(parsed) ? parsed : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Request a device code the user approves at `verification_uri`. */
export async function requestCopilotDeviceAuthorization(
  fetchImpl: FetchLike,
): Promise<CopilotDeviceAuthorization> {
  const { status, body } = await postForm(fetchImpl, COPILOT_OAUTH_CONFIG.deviceEndpoint, new URLSearchParams({
    client_id: COPILOT_OAUTH_CONFIG.clientId,
    scope: COPILOT_OAUTH_CONFIG.scope,
  }));
  const userCode = typeof body['user_code'] === 'string' ? body['user_code'] : undefined;
  const deviceCode = typeof body['device_code'] === 'string' ? body['device_code'] : undefined;
  const verificationUri =
    typeof body['verification_uri'] === 'string' ? body['verification_uri'] : undefined;
  const interval = typeof body['interval'] === 'number' ? body['interval'] : undefined;
  const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : undefined;
  if (status >= 400 || !userCode || !deviceCode || !verificationUri || !interval || !expiresIn) {
    throw new Error(
      typeof body['error_description'] === 'string' && body['error_description']
        ? body['error_description']
        : `device authorization failed (HTTP ${status})`,
    );
  }
  return { userCode, deviceCode, verificationUri, interval, expiresIn };
}

/** Poll the token endpoint ONCE (RFC 8628 §3.5 semantics). */
export async function pollCopilotDeviceToken(
  deviceCode: string,
  fetchImpl: FetchLike,
): Promise<CopilotDevicePoll> {
  const { status, body } = await postForm(fetchImpl, COPILOT_OAUTH_CONFIG.tokenEndpoint, new URLSearchParams({
    client_id: COPILOT_OAUTH_CONFIG.clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  }));
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  if (accessToken) return { state: 'done', accessToken };
  const error = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (error === 'authorization_pending') return { state: 'pending' };
  if (error === 'slow_down') {
    const interval = typeof body['interval'] === 'number' && body['interval'] > 0 ? body['interval'] : undefined;
    return { state: 'slowDown', ...(interval !== undefined ? { intervalSeconds: interval } : {}) };
  }
  if (status < 400 && !error) return { state: 'pending' };
  const message =
    typeof body['error_description'] === 'string' && body['error_description']
      ? body['error_description']
      : error ?? `device token poll failed (HTTP ${status})`;
  return { state: 'failed', message };
}

/**
 * Drive the device-code login to completion. GitHub's pacing multiplies each
 * wait (×1.2 baseline, ×1.4 once a slow_down arrives) — deliberately more
 * conservative than the RFC's flat +5s. `onPending` fires after each poll.
 */
export async function awaitCopilotDeviceToken(
  authorization: CopilotDeviceAuthorization,
  fetchImpl: FetchLike,
  options: {
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onPending?: () => void;
  } = {},
): Promise<{ accessToken: string }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.deadlineMs ?? 15 * 60_000);
  let intervalMs = Math.max(1000, authorization.interval * 1000);
  let multiplier = COPILOT_POLL_INITIAL_MULTIPLIER;
  for (;;) {
    const result = await pollCopilotDeviceToken(authorization.deviceCode, fetchImpl);
    if (result.state === 'done') return { accessToken: result.accessToken };
    if (result.state === 'failed') throw new Error(result.message);
    if (result.state === 'slowDown') {
      if (result.intervalSeconds) intervalMs = Math.max(1000, result.intervalSeconds * 1000);
      else intervalMs += 5000;
      multiplier = COPILOT_POLL_SLOW_DOWN_MULTIPLIER;
    }
    options.onPending?.();
    const waitMs = Math.ceil(intervalMs * multiplier);
    if (Date.now() + waitMs > deadline) throw new Error('device authorization timed out');
    await sleep(waitMs);
  }
}

/** The GitHub identity for the minted token (login = the account id). */
export async function fetchCopilotIdentity(
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<{ accountId?: string; email?: string }> {
  try {
    const response = await fetchImpl('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        ...COPILOT_GITHUB_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return {};
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return {};
    const accountId = typeof payload['login'] === 'string' && payload['login'].trim() ? payload['login'].trim() : undefined;
    const email = typeof payload['email'] === 'string' && payload['email'].trim() ? payload['email'].trim().toLowerCase() : undefined;
    return { ...(accountId ? { accountId } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

/**
 * Resolve the plan-advertised Copilot API endpoint
 * (`copilot_internal/user` → `endpoints.api`); `undefined` falls back to the
 * canonical personal host at dispatch time.
 */
export async function discoverCopilotApiEndpoint(
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl('https://api.github.com/copilot_internal/user', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `token ${accessToken}`,
        ...COPILOT_GITHUB_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload['endpoints'])) return undefined;
    const endpoint = payload['endpoints']['api'];
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return undefined;
    return endpoint.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Enable one policy-gated model (`POST /models/{id}/policy`). Best-effort —
 * the response is ignored and failures never fail the login.
 */
export async function enableCopilotModel(
  accessToken: string,
  modelId: string,
  baseUrl: string,
  fetchImpl: FetchLike,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(modelId)}/policy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...COPILOT_API_HEADERS,
        'Openai-Intent': 'chat-policy',
        'X-Initiator': 'user',
        'X-Interaction-Type': 'chat-policy',
      },
      body: JSON.stringify({ state: 'enabled' }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Sweep the model roster's policy-enable endpoint (batched ×5). Best-effort:
 * every failure is swallowed (already-enabled models return non-2xx too).
 */
export async function enableAllCopilotModels(
  accessToken: string,
  config: { apiEndpoint?: string; enterpriseUrl?: string } | undefined,
  fetchImpl: FetchLike,
  onProgress?: (modelId: string, ok: boolean) => void,
): Promise<void> {
  const baseUrl = copilotBaseUrl(config);
  const ids = copilotWireModelIds();
  const BATCH = 5;
  for (let i = 0; i < ids.length; i += BATCH) {
    await Promise.all(
      ids.slice(i, i + BATCH).map(async (modelId) => {
        const ok = await enableCopilotModel(accessToken, modelId, baseUrl, fetchImpl);
        onProgress?.(modelId, ok);
      }),
    );
  }
}

/**
 * "Refresh" a Copilot token — a LOCAL no-op. GitHub OAuth device tokens are
 * long-lived with no exchange endpoint; the stored access token IS the
 * credential. Returns the same pair with a far-future expiry so every generic
 * refresh path stays a no-network success.
 */
export function refreshCopilotToken(
  accessToken: string,
): { accessToken: string; refreshToken: string; expiresIn: number } {
  return {
    accessToken,
    refreshToken: accessToken,
    expiresIn: Math.floor(COPILOT_FAR_FUTURE_MS / 1000),
  };
}
