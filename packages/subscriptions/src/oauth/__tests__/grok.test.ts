/**
 * grok.test.ts — the SuperGrok (xAI) device flow: scope-bearing device
 * authorization, RFC 8628 poll semantics, OIDC-discovery token-endpoint
 * resolution + host pinning, refresh (keeping the old refresh token when the
 * response omits one), and the JWT `sub` account id.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { FetchLike } from '../fetchPort';
import {
  awaitGrokDeviceToken,
  GROK_OAUTH_CONFIG,
  grokAccountIdFromAccessToken,
  pollGrokDeviceToken,
  refreshGrokAccessToken,
  requestGrokDeviceAuthorization,
  resetGrokDiscoveryCache,
  resolveGrokTokenEndpoint,
  validateGrokAuthEndpoint,
} from '../flows/grok';

beforeEach(() => {
  resetGrokDiscoveryCache();
});

function base64urlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
  return `h.${base64urlJson(claims)}.s`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedFetch extends FetchLike {
  urls: string[];
  bodies: string[];
}

function fetchReturning(responses: Response[]): RecordedFetch {
  const urls: string[] = [];
  const bodies: string[] = [];
  let index = 0;
  const impl: FetchLike = async (url, init) => {
    urls.push(String(url));
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  };
  return Object.assign(impl, { urls, bodies });
}

describe('grok device flow', () => {
  it('requests a device authorization with the client id and full scope set', async () => {
    const fetchImpl = fetchReturning([jsonResponse({
      user_code: 'WGJS-MEFF',
      device_code: 'dev-1',
      verification_uri: 'https://auth.x.ai/device',
      verification_uri_complete: 'https://auth.x.ai/device?code=WGJS-MEFF',
      interval: 5,
      expires_in: 900,
    })]);
    const authorization = await requestGrokDeviceAuthorization(fetchImpl);

    expect(authorization).toMatchObject({
      userCode: 'WGJS-MEFF',
      deviceCode: 'dev-1',
      verificationUriComplete: 'https://auth.x.ai/device?code=WGJS-MEFF',
      interval: 5,
    });
    expect(fetchImpl.urls[0]).toContain('/oauth2/device/code');
    const params = new URLSearchParams(fetchImpl.bodies[0] ?? '');
    expect(params.get('client_id')).toBe(GROK_OAUTH_CONFIG.clientId);
    // The CLI scope set — grok-cli:access is what unlocks inference.
    expect(params.get('scope')).toContain('grok-cli:access');
    expect(params.get('scope')).toContain('offline_access');
  });

  it('treats authorization_pending and slow_down as pending, other errors as failed', async () => {
    const pending = await pollGrokDeviceToken(
      'dev', 'https://auth.x.ai/oauth2/token',
      fetchReturning([jsonResponse({ error: 'authorization_pending' }, 400)]),
    );
    expect(pending).toEqual({ state: 'pending' });

    const slow = await pollGrokDeviceToken(
      'dev', 'https://auth.x.ai/oauth2/token',
      fetchReturning([jsonResponse({ error: 'slow_down' }, 400)]),
    );
    expect(slow).toEqual({ state: 'pending', intervalSeconds: 5 });

    const denied = await pollGrokDeviceToken(
      'dev', 'https://auth.x.ai/oauth2/token',
      fetchReturning([jsonResponse({ error: 'access_denied', error_description: 'nope' }, 400)]),
    );
    expect(denied).toEqual({ state: 'failed', message: 'nope' });
  });

  it('completes on the token payload and drives the poll loop with backoff', async () => {
    const fetchImpl = fetchReturning([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse({ access_token: jwt({ sub: 'xai-sub-1' }), refresh_token: 'r-1', expires_in: 7200 }),
    ]);
    const sleeps: number[] = [];
    const result = await awaitGrokDeviceToken(
      { userCode: 'c', deviceCode: 'dev', verificationUri: 'u' },
      'https://auth.x.ai/oauth2/token',
      fetchImpl,
      { intervalMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toMatchObject({ accessToken: jwt({ sub: 'xai-sub-1' }), refreshToken: 'r-1', expiresIn: 7200 });
    // The poll floor is 1s; slow_down (+5s) applies BEFORE the next wait.
    expect(sleeps).toEqual([1000, 6000]);
  });

  it('refreshes with a refresh_token grant and keeps the old refresh token when omitted', async () => {
    const rotated = fetchReturning([jsonResponse({
      access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600,
    })]);
    expect(await refreshGrokAccessToken('rt-1', 'https://auth.x.ai/oauth2/token', rotated))
      .toEqual({ accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 });

    const kept = fetchReturning([jsonResponse({ access_token: 'at-3', expires_in: 3600 })]);
    expect(await refreshGrokAccessToken('rt-1', 'https://auth.x.ai/oauth2/token', kept))
      .toEqual({ accessToken: 'at-3', refreshToken: 'rt-1', expiresIn: 3600 });
    expect(new URLSearchParams(kept.bodies[0] ?? '').get('grant_type')).toBe('refresh_token');
  });

  it('resolves the token endpoint through OIDC discovery and pins it to *.x.ai', async () => {
    const ok = fetchReturning([jsonResponse({ token_endpoint: 'https://auth.x.ai/oauth2/token' })]);
    expect(await resolveGrokTokenEndpoint(ok)).toBe('https://auth.x.ai/oauth2/token');
    expect(ok.urls[0]).toContain('/.well-known/openid-configuration');

    // Off-origin (or plain-HTTP) discovery results are REJECTED — the endpoint
    // receives every future refresh token. (Reset the 1h cache between probes.)
    resetGrokDiscoveryCache();
    const evil = fetchReturning([jsonResponse({ token_endpoint: 'https://auth.evil.example/token' })]);
    await expect(resolveGrokTokenEndpoint(evil)).rejects.toThrow(/Invalid Grok token_endpoint/);
    resetGrokDiscoveryCache();
    const http = fetchReturning([jsonResponse({ token_endpoint: 'http://auth.x.ai/token' })]);
    await expect(resolveGrokTokenEndpoint(http)).rejects.toThrow(/Invalid Grok token_endpoint/);
    expect(() => validateGrokAuthEndpoint('https://x.ai.evil.example/token', 't')).toThrow();
    expect(validateGrokAuthEndpoint('https://accounts.x.ai/oauth2/token', 't')).toContain('accounts.x.ai');
  });

  it('reads the account id from the JWT sub claim', () => {
    expect(grokAccountIdFromAccessToken(jwt({ sub: 'xai-uuid-1' }))).toBe('xai-uuid-1');
    expect(grokAccountIdFromAccessToken('not-a-jwt')).toBeUndefined();
    expect(grokAccountIdFromAccessToken(jwt({ }))).toBeUndefined();
  });
});
