/**
 * opencodego-egress-identity (BYO half) — the host-gated identity the provider
 * header funnel (`getProviderHeaders`) applies when a provider row's base URL
 * points at opencode.ai. A user-added provider (the "add provider" path) gets
 * the SAME `user-agent` + `x-opencode-session` handling the OpenCodeGo
 * subscription relay presents, without naming the provider `opencodego`.
 *
 * @module completion/__tests__/headerBuilderOpenCodeIdentity.test
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { getProviderHeaders } from '../header-builder';
import {
  __resetOpenCodeGoHeadersForTests,
  getOpenCodeGoUserAgent,
  isOpenCodeUpstream,
  setOpenCodeGoUserAgent,
} from '../../provider-proxy/identity/openCodeGoHeaders';

const OPENCODE_ROW: LLMProvider = {
  id: 'ocg-byo',
  name: 'opencode-byo',
  apiFormat: 'openai',
  api_base_url: 'https://opencode.ai/zen/v1',
  api_key: 'sk-ocg',
  models: ['zen-claude'],
  enabled: true,
};

const OTHER_ROW: LLMProvider = {
  ...OPENCODE_ROW,
  id: 'other',
  api_base_url: 'https://api.openai.com/v1',
};

afterEach(() => {
  __resetOpenCodeGoHeadersForTests();
});

describe('getProviderHeaders opencode.ai egress identity (BYO half)', () => {
  it('opencode.ai host → product UA + caller session verbatim', () => {
    const headers = getProviderHeaders(OPENCODE_ROW, 'sk-ocg', { openCodeSession: 'client-sess-1' });
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
    expect(headers['x-opencode-session']).toBe('client-sess-1');
    // The format base is untouched.
    expect(headers['Authorization']).toBe('Bearer sk-ocg');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('subdomain host + derived session key fallback', () => {
    const row = { ...OPENCODE_ROW, api_base_url: 'https://api.opencode.ai/v1' };
    const headers = getProviderHeaders(row, 'sk-ocg', { openCodeSession: 'fnv1a8hex' });
    expect(headers['x-opencode-session']).toBe('fnv1a8hex');
  });

  it('no session value → UA only, session header omitted (never empty)', () => {
    const headers = getProviderHeaders(OPENCODE_ROW, 'sk-ocg');
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
    expect(headers['x-opencode-session']).toBeUndefined();
    expect(getProviderHeaders(OPENCODE_ROW, 'sk-ocg', { openCodeSession: '  ' })['x-opencode-session']).toBeUndefined();
  });

  it('configured embedding-app UA wins over the product default', () => {
    setOpenCodeGoUserAgent('elftia/9.9');
    expect(getProviderHeaders(OPENCODE_ROW, 'sk-ocg')['user-agent']).toBe('elftia/9.9');
  });

  it('a row-level extraHeaders user-agent / X-OpenCode-Session always wins', () => {
    const headers = getProviderHeaders(
      {
        ...OPENCODE_ROW,
        extraHeaders: { 'User-Agent': 'elftia-row/1.0', 'X-OPENCODE-SESSION': 'row-own-session' },
      },
      'sk-ocg',
      { openCodeSession: 'derived-key' },
    );
    expect(headers['User-Agent']).toBe('elftia-row/1.0');
    expect(headers['X-OPENCODE-SESSION']).toBe('row-own-session');
    // No duplicate lowercase spelling was added.
    expect(headers['x-opencode-session']).toBeUndefined();
  });

  it('opts.upstreamUrl drives the host gate over the row base', () => {
    // A non-opencode row whose RESOLVED URL points at opencode.ai (an override):
    const redirected = getProviderHeaders(OTHER_ROW, 'sk-x', {
      upstreamUrl: 'https://opencode.ai/zen/v1/chat/completions',
      openCodeSession: 'sess',
    });
    expect(redirected['user-agent']).toBe(getOpenCodeGoUserAgent());
    expect(redirected['x-opencode-session']).toBe('sess');
    // And the converse: an opencode.ai base overridden to another upstream.
    const diverted = getProviderHeaders(OPENCODE_ROW, 'sk-x', {
      upstreamUrl: 'https://relay.example.com/v1/chat/completions',
    });
    expect(diverted['user-agent']).toBeUndefined();
    expect(diverted['x-opencode-session']).toBeUndefined();
  });

  it('non-opencode host stays byte-identical (no UA, no session header)', () => {
    expect(getProviderHeaders(OTHER_ROW, 'sk-x')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-x',
    });
    // Look-alike hosts never match (suffix ≠ subdomain).
    const lookAlike = { ...OTHER_ROW, api_base_url: 'https://opencode.ai.evil.example/v1' };
    expect(getProviderHeaders(lookAlike, 'sk-x')['x-opencode-session']).toBeUndefined();
  });
});

describe('isOpenCodeUpstream', () => {
  it('matches the apex and subdomains only', () => {
    expect(isOpenCodeUpstream('https://opencode.ai/zen/v1/chat/completions')).toBe(true);
    expect(isOpenCodeUpstream('https://api.opencode.ai/v1')).toBe(true);
    expect(isOpenCodeUpstream('http://opencode.ai')).toBe(true);
    expect(isOpenCodeUpstream('https://api.openai.com/v1')).toBe(false);
    expect(isOpenCodeUpstream('https://notopencode.ai/v1')).toBe(false);
    expect(isOpenCodeUpstream('https://opencode.ai.evil.example/v1')).toBe(false);
    expect(isOpenCodeUpstream('')).toBe(false);
    expect(isOpenCodeUpstream(undefined)).toBe(false);
    expect(isOpenCodeUpstream('not a url')).toBe(false);
  });
});
