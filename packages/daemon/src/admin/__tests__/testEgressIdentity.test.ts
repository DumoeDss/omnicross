/**
 * testEgressIdentity.test.ts — the admin probe egress identity (fill-only
 * defaults over a row's own `extraHeaders`).
 *
 * Covers the two rules from the module note:
 *  - `user-agent` is ALWAYS a product identity (never Node's bare `node`),
 *    following the configured embedding-app UA when one is set, and a row's
 *    own header (any casing) wins verbatim.
 *  - `x-opencode-session` is added ONLY for opencode.ai hosts (apex +
 *    subdomains; lookalike suffixes excluded), again fill-only.
 */

import { describe, expect, it } from 'vitest';

import {
  __resetOpenCodeGoHeadersForTests,
  getOpenCodeGoUserAgent,
  OPENCODE_SESSION_HEADER,
  setOpenCodeGoUserAgent,
} from '@omnicross/core/provider-proxy/identity/openCodeGoHeaders';

import {
  ADMIN_PROBE_OPENCODE_SESSION,
  applyAdminProbeIdentity,
  isOpenCodeUpstream,
} from '../testEgressIdentity';

describe('isOpenCodeUpstream', () => {
  it('matches the apex and every subdomain of opencode.ai', () => {
    expect(isOpenCodeUpstream('https://opencode.ai/zen/v1/chat/completions')).toBe(true);
    expect(isOpenCodeUpstream('https://api.opencode.ai/v1')).toBe(true);
    expect(isOpenCodeUpstream('http://opencode.ai')).toBe(true);
  });

  it('rejects other hosts, lookalike suffixes, and unparseable URLs', () => {
    expect(isOpenCodeUpstream('https://api.openai.com/v1')).toBe(false);
    expect(isOpenCodeUpstream('https://notopencode.ai/v1')).toBe(false);
    expect(isOpenCodeUpstream('https://opencode.ai.evil.example/v1')).toBe(false);
    expect(isOpenCodeUpstream('')).toBe(false);
    expect(isOpenCodeUpstream(undefined)).toBe(false);
    expect(isOpenCodeUpstream('not a url')).toBe(false);
  });
});

describe('applyAdminProbeIdentity', () => {
  it('fills the product user-agent (never the bare node default)', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer sk-x' };
    applyAdminProbeIdentity(headers, { baseUrl: 'https://api.openai.com/v1' });
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
    expect(headers['user-agent']).not.toBe('node');
    // A non-opencode host never sees the opencode-specific session header.
    expect(headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
  });

  it('follows a configured embedding-app user-agent', () => {
    setOpenCodeGoUserAgent('elftia-probe/1.2.3');
    try {
      const headers: Record<string, string> = {};
      applyAdminProbeIdentity(headers, { baseUrl: 'https://api.openai.com/v1' });
      expect(headers['user-agent']).toBe('elftia-probe/1.2.3');
    } finally {
      __resetOpenCodeGoHeadersForTests();
    }
  });

  it('adds the session sentinel for opencode.ai rows', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer sk-x' };
    applyAdminProbeIdentity(headers, { baseUrl: 'https://opencode.ai/zen/v1/chat/completions' });
    expect(headers[OPENCODE_SESSION_HEADER]).toBe(ADMIN_PROBE_OPENCODE_SESSION);
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
  });

  it('a row-level header (any casing) wins over both fill-only defaults', () => {
    const headers: Record<string, string> = {
      'User-Agent': 'elftia-row/9.9',
      'X-OpenCode-Session': 'row-own-session',
    };
    applyAdminProbeIdentity(headers, { baseUrl: 'https://opencode.ai/zen/v1' });
    expect(headers['User-Agent']).toBe('elftia-row/9.9');
    expect(headers['user-agent']).toBeUndefined();
    expect(headers['X-OpenCode-Session']).toBe('row-own-session');
    expect(headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
  });

  it('never throws on a missing/garbage baseUrl (user-agent still fills)', () => {
    const headers: Record<string, string> = {};
    applyAdminProbeIdentity(headers, {});
    expect(headers['user-agent']).toBe(getOpenCodeGoUserAgent());
    expect(headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
  });
});
