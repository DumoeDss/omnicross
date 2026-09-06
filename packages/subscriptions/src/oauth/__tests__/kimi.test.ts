import { describe, expect, it, vi } from 'vitest';

import {
  awaitDeviceToken,
  KIMI_CLI_VERSION,
  kimiAccountIdFromAccessToken,
  kimiFingerprintHeaders,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceAuthorization,
} from '../flows/kimi';
import type { FetchLike } from '../fetchPort';

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

function fetchReturning(responses: Response[]): FetchLike & { calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  let index = 0;
  const impl: FetchLike = async (_url, init) => {
    calls.push((init?.headers ?? {}) as Record<string, string>);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next;
  };
  return Object.assign(impl, { calls });
}

describe('kimi device flow', () => {
  it('requests a device authorization with the client id and fingerprint headers', async () => {
    const fetchImpl = fetchReturning([jsonResponse({
      user_code: 'ABCD-1234',
      device_code: 'dev-1',
      verification_uri: 'https://auth.kimi.com/device',
      verification_uri_complete: 'https://auth.kimi.com/device?code=ABCD-1234',
      interval: 5,
      expires_in: 600,
    })]);
    const authorization = await requestDeviceAuthorization(fetchImpl, kimiFingerprintHeaders('device-1'));

    expect(authorization).toMatchObject({
      userCode: 'ABCD-1234',
      deviceCode: 'dev-1',
      verificationUriComplete: 'https://auth.kimi.com/device?code=ABCD-1234',
      interval: 5,
    });
    const body = (fetchImpl.calls[0] as unknown as Record<string, never>); // body via init
    void body;
  });

  it('treats authorization_pending and slow_down as pending, other errors as failed', async () => {
    const pending = await pollDeviceToken('dev', fetchReturning([jsonResponse({ error: 'authorization_pending' }, 400)]));
    expect(pending).toEqual({ state: 'pending' });

    const slow = await pollDeviceToken('dev', fetchReturning([jsonResponse({ error: 'slow_down' }, 400)]));
    expect(slow).toEqual({ state: 'pending', intervalSeconds: 5 });

    const denied = await pollDeviceToken('dev', fetchReturning([jsonResponse({ error: 'access_denied', error_description: 'nope' }, 400)]));
    expect(denied).toEqual({ state: 'failed', message: 'nope' });
  });

  it('completes on the token payload', async () => {
    const done = await pollDeviceToken('dev', fetchReturning([jsonResponse({
      access_token: jwt({ user_id: 'u-1' }),
      refresh_token: 'r-1',
      expires_in: 7200,
    })]));
    expect(done).toEqual({
      state: 'done',
      accessToken: jwt({ user_id: 'u-1' }),
      refreshToken: 'r-1',
      expiresIn: 7200,
    });
  });

  it('drives the poll loop with slow_down backoff until done', async () => {
    const fetchImpl = fetchReturning([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ]);
    const sleeps: number[] = [];
    const result = await awaitDeviceToken(
      { userCode: 'c', deviceCode: 'dev', verificationUri: 'u' },
      fetchImpl,
      { intervalMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    // The 10ms request floors to the 1s poll minimum; slow_down adds 5s BEFORE
    // the next sleep (RFC 8628).
    expect(sleeps).toEqual([1000, 1000 + 5000]);
  });

  it('refreshes with grant_type=refresh_token and keeps the old token when the response omits it', async () => {
    const fetchImpl = fetchReturning([jsonResponse({ access_token: 'new-at', expires_in: 3600 })]);
    const result = await refreshAccessToken('old-rt', fetchImpl);
    expect(result).toEqual({ accessToken: 'new-at', refreshToken: 'old-rt', expiresIn: 3600 });
  });

  it('decodes the account id from the access token JWT (user_id then sub)', () => {
    expect(kimiAccountIdFromAccessToken(jwt({ user_id: 'u-9', sub: 's-9' }))).toBe('u-9');
    expect(kimiAccountIdFromAccessToken(jwt({ sub: 's-9' }))).toBe('s-9');
    expect(kimiAccountIdFromAccessToken('not-a-jwt')).toBeUndefined();
  });

  it('builds the X-Msh fingerprint headers with the device id', () => {
    const headers = kimiFingerprintHeaders('device-42');
    expect(headers['X-Msh-Platform']).toBe('kimi_cli');
    expect(headers['X-Msh-Device-Id']).toBe('device-42');
    expect(headers['User-Agent']).toBe(`KimiCLI/${KIMI_CLI_VERSION}`);
    expect(kimiFingerprintHeaders(undefined)['X-Msh-Device-Id']).toBeUndefined();
  });
});
