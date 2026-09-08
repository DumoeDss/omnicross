/**
 * openCodeGoHeaders tests — the OpenCodeGo egress identity contract:
 * the configured/default user-agent and the x-opencode-session value matrix.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetOpenCodeGoHeadersForTests,
  extractOpenCodeSessionHeader,
  getOpenCodeGoUserAgent,
  OPENCODE_SESSION_HEADER,
  resolveOpenCodeSessionHeader,
  setOpenCodeGoUserAgent,
} from '../openCodeGoHeaders';

afterEach(() => {
  __resetOpenCodeGoHeadersForTests();
});

describe('getOpenCodeGoUserAgent', () => {
  it('defaults to omnicross/<version> (the src-run dev sentinel)', () => {
    // Vitest runs from src (no tsup define), so the fallback sentinel applies —
    // the SHIPPED dist build bakes the real workspace version.
    expect(getOpenCodeGoUserAgent()).toBe('omnicross/0.0.0-dev');
  });

  it('returns the configured value when set', () => {
    setOpenCodeGoUserAgent('elftia/1.2.3');
    expect(getOpenCodeGoUserAgent()).toBe('elftia/1.2.3');
  });

  it('trims the configured value', () => {
    setOpenCodeGoUserAgent('  elftia/1.2.3  ');
    expect(getOpenCodeGoUserAgent()).toBe('elftia/1.2.3');
  });

  it('treats a whitespace-only configured value as unset (back to the default)', () => {
    setOpenCodeGoUserAgent('elftia/1.2.3');
    setOpenCodeGoUserAgent('   ');
    expect(getOpenCodeGoUserAgent()).toBe('omnicross/0.0.0-dev');
  });

  it('null/undefined clear the slot', () => {
    setOpenCodeGoUserAgent('elftia/1.2.3');
    setOpenCodeGoUserAgent(null);
    expect(getOpenCodeGoUserAgent()).toBe('omnicross/0.0.0-dev');
    setOpenCodeGoUserAgent('elftia/1.2.3');
    setOpenCodeGoUserAgent(undefined);
    expect(getOpenCodeGoUserAgent()).toBe('omnicross/0.0.0-dev');
  });
});

describe('extractOpenCodeSessionHeader', () => {
  it('reads the lowercase header', () => {
    expect(extractOpenCodeSessionHeader({ 'x-opencode-session': 'sess-1' })).toBe('sess-1');
  });

  it('matches any raw casing (Node preserves the client’s casing)', () => {
    expect(extractOpenCodeSessionHeader({ 'X-Opencode-Session': 'sess-2' })).toBe('sess-2');
    expect(extractOpenCodeSessionHeader({ 'X-OPENCODE-SESSION': 'sess-3' })).toBe('sess-3');
  });

  it('flattens a duplicate-header array and trims the joined value', () => {
    // flattenHeaderValue joins with ', ' then the extract trims the ends.
    expect(extractOpenCodeSessionHeader({ 'x-opencode-session': [' sess-4 ', 'extra'] })).toBe('sess-4 , extra');
    expect(extractOpenCodeSessionHeader({ 'x-opencode-session': ['sess-4', 'extra'] })).toBe('sess-4, extra');
  });

  it('treats absent / empty / whitespace-only as undefined', () => {
    expect(extractOpenCodeSessionHeader({})).toBeUndefined();
    expect(extractOpenCodeSessionHeader({ 'x-opencode-session': '' })).toBeUndefined();
    expect(extractOpenCodeSessionHeader({ 'x-opencode-session': '   ' })).toBeUndefined();
  });
});

describe('resolveOpenCodeSessionHeader', () => {
  it('prefers the caller value verbatim (trimmed)', () => {
    expect(resolveOpenCodeSessionHeader(' caller-sess ', 'affinity-key')).toBe('caller-sess');
  });

  it('falls back to the session key when the caller sent none', () => {
    expect(resolveOpenCodeSessionHeader(undefined, 'affinity-key')).toBe('affinity-key');
    expect(resolveOpenCodeSessionHeader('   ', 'affinity-key')).toBe('affinity-key');
    expect(resolveOpenCodeSessionHeader(null, 'affinity-key')).toBe('affinity-key');
  });

  it('omits (undefined) when neither is present', () => {
    expect(resolveOpenCodeSessionHeader(undefined, undefined)).toBeUndefined();
    expect(resolveOpenCodeSessionHeader('', '')).toBeUndefined();
  });

  it('ignores a whitespace-only session key', () => {
    expect(resolveOpenCodeSessionHeader(undefined, '   ')).toBeUndefined();
  });

  it('exports the canonical header name', () => {
    expect(OPENCODE_SESSION_HEADER).toBe('x-opencode-session');
  });
});
