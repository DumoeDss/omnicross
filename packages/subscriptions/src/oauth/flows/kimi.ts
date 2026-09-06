/**
 * Kimi Code OAuth flow — RFC 8628 device authorization grant (host-clean).
 *
 * Matches the official Kimi CLI's client at `auth.kimi.com`: a form-encoded
 * device-authorization request, the user approving at `verification_uri`, and a
 * polled token request whose RFC error codes (`authorization_pending` /
 * `slow_down` / `expired_token` / `access_denied`) arrive as HTTP 400 bodies —
 * which is why the poll does NOT use `postForm` (that helper rejects on
 * `error`). No PKCE, no client secret, no scopes. Refresh is a standard
 * `refresh_token` grant on the same endpoint.
 *
 * The access token's JWT payload carries `user_id` (fallback `sub`) — that is
 * the account id. Inference and the `/coding/v1/usages` quota endpoint ride
 * `api.kimi.com/coding/v1`; every Kimi request also carries the
 * `X-Msh-*` fingerprint headers (`kimiFingerprintHeaders`).
 *
 * @module @omnicross/subscriptions/oauth/flows/kimi
 */

import crypto from 'node:crypto';
import * as os from 'node:os';

import type { FetchLike } from '../fetchPort';

/** Kimi CLI OAuth configuration (public client, matches the official CLI). */
export const KIMI_OAUTH_CONFIG = {
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
  deviceAuthorizationEndpoint: 'https://auth.kimi.com/api/oauth/device_authorization',
  tokenEndpoint: 'https://auth.kimi.com/api/oauth/token',
} as const;

/**
 * The client version reported in `User-Agent`/`X-Msh-Version`. Kimi's backend
 * gates on the CLI identity; this mirrors a current official CLI version.
 * Overridable via `KIMI_CLI_VERSION` when the upstream moves.
 */
export const KIMI_CLI_VERSION = process.env['KIMI_CLI_VERSION'] ?? '1.0.0';

/** Device-authorization response (RFC 8628 §3.2). */
export interface KimiDeviceAuthorization {
  userCode: string;
  deviceCode: string;
  /** Preferred: pre-fills the code when opened in the user's browser. */
  verificationUri: string;
  verificationUriComplete?: string;
  /** Poll interval in seconds (RFC default 5). */
  interval?: number;
  /** Lifetime in seconds. */
  expiresIn?: number;
}

/** One polled token attempt's outcome. */
export type KimiDevicePoll =
  | { state: 'pending'; intervalSeconds?: number }
  | { state: 'done'; accessToken: string; refreshToken: string; expiresIn: number }
  | { state: 'failed'; message: string };

function sanitizeHeaderValue(value: string, fallback = ''): string {
  const sanitized = value.replace(/[^\x20-\x7E]/g, '').trim();
  return sanitized || fallback;
}

function deviceModel(): string {
  const platform = os.platform();
  const label = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform;
  return [label, os.release(), os.arch()].filter(Boolean).join(' ').trim();
}

/**
 * The fingerprint headers every Kimi API request carries (auth, inference,
 * usage). `deviceId` is the per-account stable device id stored on the token
 * config — NOT a host-global value, so two accounts on one install present two
 * device identities, matching how the CLI scopes its `kimi-device-id` file per
 * credential store.
 */
export function kimiFingerprintHeaders(deviceId: string | undefined): Record<string, string> {
  return {
    'User-Agent': `KimiCLI/${KIMI_CLI_VERSION}`,
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': KIMI_CLI_VERSION,
    'X-Msh-Device-Name': sanitizeHeaderValue(os.hostname(), 'unknown'),
    'X-Msh-Device-Model': sanitizeHeaderValue(deviceModel(), 'unknown'),
    'X-Msh-Os-Version': sanitizeHeaderValue(os.version(), 'unknown'),
    ...(deviceId ? { 'X-Msh-Device-Id': sanitizeHeaderValue(deviceId) } : {}),
  };
}

/** Mint the stable per-account device id (hex UUID, no dashes). */
export function generateKimiDeviceId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

async function postFormRaw(
  fetchImpl: FetchLike,
  url: string,
  params: URLSearchParams,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
      body: params.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('token endpoint timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Request a device code the user approves at `verification_uri`. */
export async function requestDeviceAuthorization(
  fetchImpl: FetchLike,
  fingerprint?: Record<string, string>,
): Promise<KimiDeviceAuthorization> {
  const { status, body } = await postFormRaw(
    fetchImpl,
    KIMI_OAUTH_CONFIG.deviceAuthorizationEndpoint,
    new URLSearchParams({ client_id: KIMI_OAUTH_CONFIG.clientId }),
    fingerprint ?? {},
  );
  const userCode = typeof body['user_code'] === 'string' ? body['user_code'] : undefined;
  const deviceCode = typeof body['device_code'] === 'string' ? body['device_code'] : undefined;
  const verificationUri =
    typeof body['verification_uri'] === 'string' ? body['verification_uri'] : undefined;
  if (status >= 400 || !userCode || !deviceCode || !verificationUri) {
    const message = typeof body['error_description'] === 'string'
      ? body['error_description']
      : typeof body['msg'] === 'string'
        ? body['msg']
        : `device authorization failed (HTTP ${status})`;
    throw new Error(message);
  }
  return {
    userCode,
    deviceCode,
    verificationUri,
    ...(typeof body['verification_uri_complete'] === 'string'
      ? { verificationUriComplete: body['verification_uri_complete'] as string }
      : {}),
    ...(typeof body['interval'] === 'number' ? { interval: body['interval'] } : {}),
    ...(typeof body['expires_in'] === 'number' ? { expiresIn: body['expires_in'] } : {}),
  };
}

/**
 * Poll the token endpoint ONCE. RFC 8628 §3.5 semantics: `authorization_pending`
 * keeps polling, `slow_down` adds 5s to the interval, anything else fails. The
 * error codes arrive on HTTP 400 with an `error` JSON field, so this deliberately
 * does NOT route through `postForm` (which rejects on any `error` body).
 */
export async function pollDeviceToken(
  deviceCode: string,
  fetchImpl: FetchLike,
  fingerprint?: Record<string, string>,
): Promise<KimiDevicePoll> {
  const { status, body } = await postFormRaw(
    fetchImpl,
    KIMI_OAUTH_CONFIG.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: KIMI_OAUTH_CONFIG.clientId,
      device_code: deviceCode,
    }),
    fingerprint ?? {},
  );
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined;
  if (accessToken && refreshToken) {
    const expiresIn = typeof body['expires_in'] === 'number' && body['expires_in'] > 0
      ? body['expires_in']
      : 3600;
    return { state: 'done', accessToken, refreshToken, expiresIn };
  }
  const error = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (error === 'authorization_pending') return { state: 'pending' };
  if (error === 'slow_down') return { state: 'pending', intervalSeconds: 5 };
  if (status < 400 && !error) return { state: 'pending' };
  const message = typeof body['error_description'] === 'string' && body['error_description']
    ? body['error_description']
    : error ?? `device token poll failed (HTTP ${status})`;
  return { state: 'failed', message };
}

/**
 * Drive the device-code login to completion: poll at the device flow's interval
 * (`slow_down` +5s each time) until done/expired/denied or `deadlineMs` elapses.
 * `onPending` fires after each pending poll (so a CLI can render a spinner).
 */
export async function awaitDeviceToken(
  authorization: KimiDeviceAuthorization,
  fetchImpl: FetchLike,
  options: {
    fingerprint?: Record<string, string>;
    intervalMs?: number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onPending?: () => void;
  } = {},
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.deadlineMs ?? 15 * 60_000);
  // `options.intervalMs` is milliseconds; the device-authorization response's
  // `interval` is seconds (RFC 8628). Floor at 1s, poll no faster.
  const baseIntervalMs = options.intervalMs ?? (authorization.interval ?? 5) * 1000;
  let intervalMs = Math.max(1000, baseIntervalMs);
  for (;;) {
    const result = await pollDeviceToken(authorization.deviceCode, fetchImpl, options.fingerprint);
    if (result.state === 'done') return result;
    if (result.state === 'failed') throw new Error(result.message);
    // Apply the slow_down increment BEFORE sleeping so the NEXT wait is longer.
    if (result.state === 'pending' && result.intervalSeconds) intervalMs += result.intervalSeconds * 1000;
    options.onPending?.();
    if (Date.now() + intervalMs > deadline) throw new Error('device authorization timed out');
    await sleep(intervalMs);
  }
}

/** Refresh the access token with a `refresh_token` grant. */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: FetchLike,
  fingerprint?: Record<string, string>,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const { status, body } = await postFormRaw(
    fetchImpl,
    KIMI_OAUTH_CONFIG.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KIMI_OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
    }),
    fingerprint ?? {},
  );
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  if (status >= 400 || !accessToken) {
    const message = typeof body['error_description'] === 'string' && body['error_description']
      ? body['error_description']
      : typeof body['error'] === 'string'
        ? body['error']
        : `refresh failed (HTTP ${status})`;
    throw new Error(message);
  }
  return {
    accessToken,
    // Kimi rotates the refresh token; keep the old one when the response omits it.
    refreshToken: typeof body['refresh_token'] === 'string' && body['refresh_token']
      ? body['refresh_token']
      : refreshToken,
    expiresIn: typeof body['expires_in'] === 'number' && body['expires_in'] > 0
      ? body['expires_in']
      : 3600,
  };
}

/**
 * Decode the access-token JWT's `user_id | sub` claim (no verification — the
 * issuer is trusted; we only read an id).
 */
export function kimiAccountIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const claims: unknown = JSON.parse(json);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return undefined;
    const record = claims as Record<string, unknown>;
    for (const key of ['user_id', 'sub']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
