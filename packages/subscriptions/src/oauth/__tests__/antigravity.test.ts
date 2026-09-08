/**
 * antigravity flow tests — host-clean OAuth flow construction with NO network:
 *   - authorize URL: the Antigravity client id, the FIXED loopback redirect_uri
 *     `http://127.0.0.1:51121/oauth-callback`, the FIVE Antigravity scopes,
 *     access_type=offline + prompt=consent, and NO PKCE params,
 *   - exchange: authorization-code + client_secret + the SAME loopback
 *     redirect_uri, NO code_verifier,
 *   - refresh: refresh_token + client_secret; the response's absent
 *     refresh_token is intentionally not surfaced,
 *   - userinfo: Bearer header, email extraction, non-2xx → undefined.
 */
import { describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../fetchPort';
import * as antigravityOAuth from '../flows/antigravity';

/** A mock `FetchLike` returning a JSON body + recording the request. */
function jsonFetch(body: unknown, calls?: Array<{ url: string; init: RequestInit }>): FetchLike {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls?.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchLike;
}

describe('antigravity generateAuthParams', () => {
  it('builds the authorize URL with the loopback redirect, 5 scopes, and NO PKCE', () => {
    const { authUrl, codeVerifier, state } = antigravityOAuth.generateAuthParams();

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    );
    // The client's FIXED loopback redirect (port 51121, path /oauth-callback).
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:51121/oauth-callback');
    // Exactly the five Antigravity scopes.
    expect((q.get('scope') ?? '').split(' ')).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ]);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('state')).toBe(state);
    // NO PKCE on this client.
    expect(q.get('code_challenge')).toBeNull();
    expect(q.get('code_challenge_method')).toBeNull();
    expect(codeVerifier).toBe('');
    expect(state).toHaveLength(32);
  });
});

describe('antigravity exchangeCodeForTokens', () => {
  it('posts authorization_code + client_secret + loopback redirect_uri, no verifier', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jsonFetch(
      { access_token: 'ag-at', refresh_token: 'ag-rt', expires_in: 3600 },
      calls,
    );

    const result = await antigravityOAuth.exchangeCodeForTokens('the-code', fetchImpl);
    expect(result).toEqual({ accessToken: 'ag-at', refreshToken: 'ag-rt', expiresIn: 3600 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    const body = String(calls[0]?.init.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(new URLSearchParams(body).get('client_secret')).toBe(
      Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=', 'base64').toString(),
    );
    expect(body).toContain('code=the-code');
    expect(body).toContain(
      `redirect_uri=${encodeURIComponent('http://127.0.0.1:51121/oauth-callback')}`,
    );
    expect(body).not.toContain('code_verifier');
  });

  it('rejects with the upstream error message', async () => {
    const fetchImpl = jsonFetch({ error: 'invalid_grant', error_description: 'bad code' });
    await expect(antigravityOAuth.exchangeCodeForTokens('x', fetchImpl)).rejects.toThrow('bad code');
  });
});

describe('antigravity refreshAccessToken', () => {
  it('posts refresh_token + client_secret and surfaces only access+expiresIn', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jsonFetch({ access_token: 'ag-at-2', expires_in: 3600 }, calls);

    const result = await antigravityOAuth.refreshAccessToken('ag-rt', fetchImpl);
    expect(result).toEqual({ accessToken: 'ag-at-2', expiresIn: 3600 });
    expect(String(calls[0]?.init.body)).toContain('grant_type=refresh_token');
    expect(String(calls[0]?.init.body)).toContain('refresh_token=ag-rt');
    expect(String(calls[0]?.init.body)).toContain('client_secret=');
  });
});

describe('antigravity fetchUserEmail', () => {
  it('GETs userinfo with the Bearer and extracts the email', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jsonFetch({ email: 'dev@example.com' }, calls);

    expect(await antigravityOAuth.fetchUserEmail('ag-at', fetchImpl)).toBe('dev@example.com');
    expect(calls[0]?.url).toBe('https://www.googleapis.com/oauth2/v1/userinfo?alt=json');
    expect((calls[0]?.init.headers as Record<string, string>)['Authorization']).toBe('Bearer ag-at');
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('resolves undefined on a non-2xx or unparseable response (never fails login)', async () => {
    const notOk = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as FetchLike;
    expect(await antigravityOAuth.fetchUserEmail('t', notOk)).toBeUndefined();

    const throws = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as FetchLike;
    expect(await antigravityOAuth.fetchUserEmail('t', throws)).toBeUndefined();
  });
});
