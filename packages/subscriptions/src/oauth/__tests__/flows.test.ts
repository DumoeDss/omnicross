/**
 * flows.test.ts — host-clean OAuth flow unit tests.
 *
 * Proves the flow construction WITHOUT any live network or electron:
 *   - authorize URL: with FIXED PKCE inputs (mocked `crypto.randomBytes`), assert
 *     the expected host/path/query
 *     (per-provider clientId, redirect_uri, scope, extra params, PKCE shapes),
 *   - exchange parsing: claude scopes, codex idToken, gemini refresh_token,
 *   - refresh: claude/codex/gemini, gemini reuses the old refresh_token (the
 *     response omits it), codex defaults expiresIn to 3600,
 *   - error translation: upstream `error`/`error_description` → same Error message,
 *     unparseable body → the per-method parse-error string,
 *   - injected fetch: every request goes through the mock (no global fetch / net).
 */

import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FetchLike } from '../fetchPort';
import * as claudeOAuth from '../flows/claude';
import * as codexOAuth from '../flows/codex';
import * as geminiOAuth from '../flows/gemini';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A mock `FetchLike` returning a JSON body + recording the request. */
function jsonFetch(body: unknown, calls?: Array<{ url: string; init: RequestInit }>): FetchLike {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls?.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

/**
 * Pin `crypto.randomBytes` so PKCE/state are deterministic. The verifier mock
 * returns a fixed buffer whose `.toString('base64url')` / `.toString('hex')`
 * matches what the real helper would produce from the same bytes — we use the
 * REAL crypto for the challenge, so the URL is a faithful end-to-end snapshot.
 */
function pinRandomBytes(verifierByte: number, stateByte: number): void {
  vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
    // 16 bytes → state; everything else → verifier (32 or 64).
    const fill = size === 16 ? stateByte : verifierByte;
    return Buffer.alloc(size, fill);
  }) as typeof crypto.randomBytes);
}

describe('claude OAuth flow', () => {
  it('builds the authorize URL byte-faithfully (fixed PKCE)', () => {
    pinRandomBytes(0xab, 0xcd);
    const { authUrl, codeVerifier, state } = claudeOAuth.generateAuthParams();

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    const q = url.searchParams;
    expect(q.get('code')).toBe('true');
    expect(q.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(q.get('scope')).toBe(
      'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    );
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe(state);

    // PKCE: verifier = 32 bytes base64url; challenge = SHA256(verifier) base64url.
    expect(codeVerifier).toBe(Buffer.alloc(32, 0xab).toString('base64url'));
    expect(q.get('code_challenge')).toBe(
      crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    );
    expect(state).toBe(Buffer.alloc(16, 0xcd).toString('hex'));
  });

  it('setup-token authorize URL uses the minimal scope', () => {
    pinRandomBytes(0x01, 0x02);
    const { authUrl } = claudeOAuth.generateSetupTokenParams();
    const q = new URL(authUrl).searchParams;
    expect(q.get('scope')).toBe('user:inference');
    expect(q.get('code')).toBe('true');
  });

  it('exchanges code for tokens (scopes parsed from response)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = jsonFetch(
      { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b c' },
      calls,
    );
    const out = await claudeOAuth.exchangeCodeForTokens(
      { authorizationCode: 'code', codeVerifier: 'ver', state: 'st' },
      fetchImpl,
    );
    expect(out).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scopes: ['a', 'b', 'c'] });
    // Injected fetch hit the claude token endpoint with form body + state.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://platform.claude.com/v1/oauth/token');
    // Claude token endpoint needs a JSON body + the claude-cli identity headers
    // (Cloudflare 403s a bare form post) — see CLAUDE_TOKEN_HEADERS.
    expect(calls[0].init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli/1.0.56 (external, cli)',
      Referer: 'https://claude.ai/',
      Origin: 'https://claude.ai',
    });
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.grant_type).toBe('authorization_code');
    expect(sent.code).toBe('code');
    expect(sent.state).toBe('st');
  });

  it('exchange falls back to config scopes when response omits scope', async () => {
    const out = await claudeOAuth.exchangeCodeForTokens(
      { authorizationCode: 'c', codeVerifier: 'v', state: 's' },
      jsonFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 10 }),
    );
    expect(out.scopes).toEqual([
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ]);
  });

  it('setup-token exchange omits refresh_token', async () => {
    const out = await claudeOAuth.exchangeSetupTokenCode(
      { authorizationCode: 'c', codeVerifier: 'v', state: 's' },
      jsonFetch({ access_token: 'at', expires_in: 99, scope: 'user:inference' }),
    );
    expect(out).toEqual({ accessToken: 'at', expiresIn: 99, scopes: ['user:inference'] });
  });

  it('refreshes (reuses old refresh_token when response omits it)', async () => {
    const out = await claudeOAuth.refreshAccessToken('old-rt', jsonFetch({ access_token: 'new', expires_in: 7200 }));
    expect(out).toEqual({ accessToken: 'new', refreshToken: 'old-rt', expiresIn: 7200 });
  });

  it('translates upstream error → error_description', async () => {
    await expect(
      claudeOAuth.refreshAccessToken('rt', jsonFetch({ error: 'invalid_grant', error_description: 'expired' })),
    ).rejects.toThrow('expired');
  });

  it('translates an OBJECT error (Anthropic `{ type, message }`) → its message, not "[object Object]"', async () => {
    // Anthropic's token endpoint returns `{"error":{"type":"...","message":"..."}}`.
    const rej = claudeOAuth.exchangeCodeForTokens(
      { authorizationCode: 'c', codeVerifier: 'v', state: 's' },
      jsonFetch({ error: { type: 'invalid_request', message: 'invalid code_verifier' } }),
    );
    await expect(rej).rejects.toThrow('invalid code_verifier');
    await expect(rej).rejects.not.toThrow('[object Object]');
  });

  it('translates unparseable body → parse-error string', async () => {
    await expect(
      claudeOAuth.exchangeCodeForTokens(
        { authorizationCode: 'c', codeVerifier: 'v', state: 's' },
        jsonFetch('<<not json>>'),
      ),
    ).rejects.toThrow('Failed to parse token response');
  });
});

describe('codex OAuth flow', () => {
  it('builds the authorize URL byte-faithfully (verifier = 64-byte hex)', () => {
    pinRandomBytes(0x11, 0x22);
    const { authUrl, codeVerifier, state } = codexOAuth.generateAuthParams();
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(q.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(q.get('scope')).toBe('openid profile email offline_access');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe(state);
    // verifier = 64 bytes → 128 hex chars.
    expect(codeVerifier).toBe(Buffer.alloc(64, 0x11).toString('hex'));
    expect(codeVerifier).toHaveLength(128);
    expect(q.get('code_challenge')).toBe(
      crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
    );
  });

  it('exchange parses idToken and sends NO state', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const out = await codexOAuth.exchangeCodeForTokens(
      { authorizationCode: 'code', codeVerifier: 'ver', state: 'ignored' },
      jsonFetch({ access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_in: 3600 }, calls),
    );
    expect(out).toEqual({ accessToken: 'at', refreshToken: 'rt', idToken: 'idt', expiresIn: 3600 });
    const sent = new URLSearchParams(calls[0].init.body as string);
    expect(sent.has('state')).toBe(false);
    expect(sent.get('grant_type')).toBe('authorization_code');
  });

  it('refresh carries scope + defaults expiresIn to 3600 + reuses old refresh_token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const out = await codexOAuth.refreshAccessToken('old-rt', jsonFetch({ access_token: 'new', id_token: 'idt' }, calls));
    expect(out).toEqual({ accessToken: 'new', idToken: 'idt', refreshToken: 'old-rt', expiresIn: 3600 });
    const sent = new URLSearchParams(calls[0].init.body as string);
    expect(sent.get('scope')).toBe('openid profile email');
  });
});

describe('gemini OAuth flow', () => {
  it('builds the authorize URL byte-faithfully (access_type + prompt + oob)', () => {
    pinRandomBytes(0x33, 0x44);
    const { authUrl, codeVerifier } = geminiOAuth.generateAuthParams();
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(q.get('redirect_uri')).toBe('urn:ietf:wg:oauth:2.0:oob');
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(codeVerifier).toBe(Buffer.alloc(32, 0x33).toString('base64url'));
  });

  it('exchange sends client_secret + parses refresh_token (positional args)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const out = await geminiOAuth.exchangeCodeForTokens(
      'auth-code',
      'verifier',
      jsonFetch({ access_token: 'at', refresh_token: 'rt', expires_in: 3599 }, calls),
    );
    expect(out).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresIn: 3599 });
    const sent = new URLSearchParams(calls[0].init.body as string);
    // Public installed-app client secret.
    expect(sent.get('client_secret')).toBe('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'); // allowlist-secret
    expect(sent.get('code')).toBe('auth-code');
  });

  it('refresh succeeds WITHOUT a refresh_token in the response (gemini omits it)', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const out = await geminiOAuth.refreshAccessToken('old-rt', jsonFetch({ access_token: 'new', expires_in: 3600 }, calls));
    // No refreshToken in the result shape — the caller (store) reuses the old one.
    expect(out).toEqual({ accessToken: 'new', expiresIn: 3600 });
    const sent = new URLSearchParams(calls[0].init.body as string);
    // Public installed-app client secret.
    expect(sent.get('client_secret')).toBe('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'); // allowlist-secret
    expect(sent.get('refresh_token')).toBe('old-rt');
  });
});
