/**
 * Grok (xAI SuperGrok) OAuth flow — RFC 8628 device authorization grant.
 *
 * Mirrors the public Grok CLI client at `auth.x.ai` (client id reverse-derived
 * from the official CLI, same as the audit source): a form-encoded
 * device-authorization request with the CLI scopes, the user approving at
 * `verification_uri`, and a polled token request whose RFC error codes arrive
 * as HTTP 400 JSON bodies (hence the raw-form POST helper — the shared
 * `postForm` rejects on any `error` body). Refresh is a standard
 * `refresh_token` grant on the same endpoint.
 *
 * The token endpoint is NOT hard-coded: it is resolved through xAI's OIDC
 * discovery document and pinned to HTTPS `x.ai` / `*.x.ai` (the discovery
 * response is long-lived and its endpoint receives every future refresh
 * token, so a drifted document must not redirect credentials off-origin).
 * The discovery result is cached process-wide for an hour.
 *
 * The access token is a JWT; its `sub` claim is the account id. Inference
 * rides `api.x.ai/v1/responses` (the codex-style Responses wire); the weekly
 * credits / unified monthly quota lives behind `cli-chat-proxy.grok.com/v1/
 * billing` (see `GrokAllowanceCollector`).
 *
 * Escape hatches: `GROK_OAUTH_DEVICE_ENDPOINT` / `GROK_OAUTH_DISCOVERY_URL`
 * override the two endpoints (host-pinning still applies to the discovery
 * result).
 *
 * @module @omnicross/subscriptions/oauth/flows/grok
 */

import type { FetchLike } from '../fetchPort';

/** Grok CLI OAuth configuration (public client, mirrors the official CLI). */
export const GROK_OAUTH_CONFIG = {
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  deviceAuthorizationEndpoint:
    process.env['GROK_OAUTH_DEVICE_ENDPOINT'] ?? 'https://auth.x.ai/oauth2/device/code',
  discoveryUrl:
    process.env['GROK_OAUTH_DISCOVERY_URL'] ?? 'https://auth.x.ai/.well-known/openid-configuration',
  /** The CLI's full scope set — the token must carry `grok-cli:access` for inference. */
  scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
} as const;

/** How long a resolved OIDC token endpoint is reused before re-discovery. */
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;

/** Device-authorization response (RFC 8628 §3.2). */
export interface GrokDeviceAuthorization {
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
export type GrokDevicePoll =
  | { state: 'pending'; intervalSeconds?: number }
  | { state: 'done'; accessToken: string; refreshToken: string; expiresIn: number }
  | { state: 'failed'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `x.ai` or any `*.x.ai` host — the only origins a token endpoint may live on. */
export function isGrokAuthHostname(host: string): boolean {
  return host === 'x.ai' || host.endsWith('.x.ai');
}

/**
 * Validate an endpoint URL against the token-endpoint contract: HTTPS and an
 * `x.ai` / `*.x.ai` host. Throws a descriptive error otherwise.
 */
export function validateGrokAuthEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Grok ${field}: ${url}`);
  }
  if (parsed.protocol !== 'https:' || !isGrokAuthHostname(parsed.hostname.toLowerCase())) {
    throw new Error(`Invalid Grok ${field}: ${url}`);
  }
  return url;
}

let cachedDiscovery: { tokenEndpoint: string; resolvedAt: number } | undefined;

/** Test seam: drop the discovery cache (the cache is process-level). */
export function resetGrokDiscoveryCache(): void {
  cachedDiscovery = undefined;
}

/**
 * Resolve the OIDC token endpoint via discovery (cached 1h). The document's
 * `token_endpoint` is host-pinned so a compromised or drifted discovery
 * response can never redirect credentials off the xAI origin.
 */
export async function resolveGrokTokenEndpoint(
  fetchImpl: FetchLike,
  timeoutMs = 15_000,
): Promise<string> {
  if (cachedDiscovery && Date.now() - cachedDiscovery.resolvedAt < DISCOVERY_CACHE_MS) {
    return cachedDiscovery.tokenEndpoint;
  }
  let response: Response;
  try {
    response = await fetchImpl(GROK_OAUTH_CONFIG.discoveryUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Grok OIDC discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`Grok OIDC discovery returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Grok OIDC discovery returned invalid JSON');
  }
  const tokenEndpoint =
    isRecord(payload) && typeof payload['token_endpoint'] === 'string'
      ? payload['token_endpoint'].trim()
      : '';
  if (!tokenEndpoint) throw new Error('Grok OIDC discovery response missing token_endpoint');
  validateGrokAuthEndpoint(tokenEndpoint, 'token_endpoint');
  cachedDiscovery = { tokenEndpoint, resolvedAt: Date.now() };
  return tokenEndpoint;
}

async function postFormRaw(
  fetchImpl: FetchLike,
  url: string,
  params: URLSearchParams,
  timeoutMs = 30_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
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
    body = isRecord(parsed) ? parsed : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/** Request a device code the user approves at `verification_uri`. */
export async function requestGrokDeviceAuthorization(
  fetchImpl: FetchLike,
): Promise<GrokDeviceAuthorization> {
  const { status, body } = await postFormRaw(
    fetchImpl,
    GROK_OAUTH_CONFIG.deviceAuthorizationEndpoint,
    new URLSearchParams({
      client_id: GROK_OAUTH_CONFIG.clientId,
      scope: GROK_OAUTH_CONFIG.scopes.join(' '),
    }),
  );
  const userCode = typeof body['user_code'] === 'string' ? body['user_code'] : undefined;
  const deviceCode = typeof body['device_code'] === 'string' ? body['device_code'] : undefined;
  const verificationUri =
    typeof body['verification_uri'] === 'string' ? body['verification_uri'] : undefined;
  if (status >= 400 || !userCode || !deviceCode || !verificationUri) {
    const message =
      typeof body['error_description'] === 'string' && body['error_description']
        ? body['error_description']
        : typeof body['error'] === 'string'
          ? body['error']
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
 * keeps polling, `slow_down` adds 5s to the interval, anything else fails.
 */
export async function pollGrokDeviceToken(
  deviceCode: string,
  tokenEndpoint: string,
  fetchImpl: FetchLike,
): Promise<GrokDevicePoll> {
  const { status, body } = await postFormRaw(fetchImpl, tokenEndpoint, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: GROK_OAUTH_CONFIG.clientId,
    device_code: deviceCode,
  }));
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined;
  if (accessToken && refreshToken) {
    const expiresIn =
      typeof body['expires_in'] === 'number' && body['expires_in'] > 0
        ? body['expires_in']
        : 3600;
    return { state: 'done', accessToken, refreshToken, expiresIn };
  }
  const error = typeof body['error'] === 'string' ? body['error'] : undefined;
  if (error === 'authorization_pending') return { state: 'pending' };
  if (error === 'slow_down') return { state: 'pending', intervalSeconds: 5 };
  if (status < 400 && !error) return { state: 'pending' };
  const message =
    typeof body['error_description'] === 'string' && body['error_description']
      ? body['error_description']
      : error ?? `device token poll failed (HTTP ${status})`;
  return { state: 'failed', message };
}

/**
 * Drive the device-code login to completion: poll at the device flow's
 * interval (`slow_down` +5s each time, applied BEFORE the next wait) until
 * done/expired/denied or `deadlineMs` elapses. `onPending` fires after each
 * pending poll (so a CLI can render a spinner).
 */
export async function awaitGrokDeviceToken(
  authorization: GrokDeviceAuthorization,
  tokenEndpoint: string,
  fetchImpl: FetchLike,
  options: {
    intervalMs?: number;
    deadlineMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onPending?: () => void;
  } = {},
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.deadlineMs ?? 15 * 60_000);
  const baseIntervalMs = options.intervalMs ?? (authorization.interval ?? 5) * 1000;
  let intervalMs = Math.max(1000, baseIntervalMs);
  for (;;) {
    const result = await pollGrokDeviceToken(authorization.deviceCode, tokenEndpoint, fetchImpl);
    if (result.state === 'done') return result;
    if (result.state === 'failed') throw new Error(result.message);
    // Apply the slow_down increment BEFORE sleeping so the NEXT wait is longer.
    if (result.state === 'pending' && result.intervalSeconds) {
      intervalMs += result.intervalSeconds * 1000;
    }
    options.onPending?.();
    if (Date.now() + intervalMs > deadline) throw new Error('device authorization timed out');
    await sleep(intervalMs);
  }
}

/** Refresh the access token with a `refresh_token` grant. */
export async function refreshGrokAccessToken(
  refreshToken: string,
  tokenEndpoint: string,
  fetchImpl: FetchLike,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const { status, body } = await postFormRaw(fetchImpl, tokenEndpoint, new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: GROK_OAUTH_CONFIG.clientId,
    refresh_token: refreshToken,
  }));
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : undefined;
  if (status >= 400 || !accessToken) {
    const message =
      typeof body['error_description'] === 'string' && body['error_description']
        ? body['error_description']
        : typeof body['error'] === 'string'
          ? body['error']
          : `refresh failed (HTTP ${status})`;
    throw new Error(message);
  }
  return {
    accessToken,
    // Keep the old refresh token when the response omits one (no proven rotation).
    refreshToken:
      typeof body['refresh_token'] === 'string' && body['refresh_token']
        ? body['refresh_token']
        : refreshToken,
    expiresIn:
      typeof body['expires_in'] === 'number' && body['expires_in'] > 0
        ? body['expires_in']
        : 3600,
  };
}

/**
 * Decode the access-token JWT's `sub` claim (no verification — the issuer is
 * trusted; we only read an id).
 */
export function grokAccountIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const claims: unknown = JSON.parse(json);
    if (!isRecord(claims)) return undefined;
    const sub = claims['sub'];
    return typeof sub === 'string' && sub.trim() ? sub.trim() : undefined;
  } catch {
    return undefined;
  }
}
