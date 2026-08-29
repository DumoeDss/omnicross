/**
 * claudeCodeHeaders tests — the Anthropic wire-protocol + Claude Code client
 * headers the subscription relay puts on every upstream request.
 *
 * The regression under guard: the relay used to send ONLY `content-type` +
 * `Authorization`, so `api.anthropic.com` answered
 * `400 anthropic-version: header is required`. These assert the protocol headers
 * are unconditional, that a caller's real values always beat the defaults, and
 * that nothing token-bearing can be forwarded.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAnthropicBeta,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_CLAUDE_CODE_HEADERS,
  extractClaudeClientHeaders,
  fillMissingHeaders,
} from '../claudeCodeHeaders';

describe('extractClaudeClientHeaders', () => {
  it('forwards the Claude Code client headers, lowercased', () => {
    const out = extractClaudeClientHeaders({
      'User-Agent': 'claude-cli/2.1.223 (external, cli)',
      'X-App': 'cli',
      'X-Stainless-Lang': 'js',
      'x-stainless-os': 'MacOS',
      'anthropic-version': '2024-10-22',
      accept: 'application/json',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
    });
    expect(out).toEqual({
      'user-agent': 'claude-cli/2.1.223 (external, cli)',
      'x-app': 'cli',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'MacOS',
      'anthropic-version': '2024-10-22',
      accept: 'application/json',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
    });
  });

  it('NEVER forwards auth / cookie / transport headers', () => {
    const out = extractClaudeClientHeaders({
      authorization: 'Bearer SECRET-TOKEN',
      'x-api-key': 'sk-SECRET',
      cookie: 'session=SECRET',
      'proxy-authorization': 'Basic SECRET',
      host: 'evil.example',
      'content-length': '123',
      connection: 'keep-alive',
      'user-agent': 'claude-cli/1.0.0 (external, cli)',
    });
    expect(out).toEqual({ 'user-agent': 'claude-cli/1.0.0 (external, cli)' });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('drops `accept-encoding` (a client may ask for an undecodable zstd)', () => {
    expect(extractClaudeClientHeaders({ 'accept-encoding': 'zstd, gzip' })).toEqual({});
  });

  it('ignores unknown headers and empty values', () => {
    expect(
      extractClaudeClientHeaders({ 'x-random': 'v', 'user-agent': '', 'x-app': undefined }),
    ).toEqual({});
  });
});

describe('buildAnthropicBeta', () => {
  it('always carries the OAuth flag (this path uses a subscription token)', () => {
    expect(buildAnthropicBeta('claude-sonnet-4-5', null)).toContain('oauth-2025-04-20');
  });

  it('uses the full baseline for a non-haiku model', () => {
    expect(buildAnthropicBeta('claude-opus-4-5', undefined).split(',')).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
      'fine-grained-tool-streaming-2025-05-14',
    ]);
  });

  it('uses the reduced baseline for haiku', () => {
    expect(buildAnthropicBeta('claude-haiku-4-5', undefined).split(',')).toEqual([
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
    ]);
  });

  it("merges the caller's flags without duplicating the baseline", () => {
    const out = buildAnthropicBeta(
      'claude-sonnet-4-5',
      ' oauth-2025-04-20 , context-1m-2025-08-07 ',
    ).split(',');
    expect(out.filter((f) => f === 'oauth-2025-04-20')).toHaveLength(1);
    expect(out).toContain('context-1m-2025-08-07');
  });

  it('an undefined model still yields the full baseline (never empty)', () => {
    expect(buildAnthropicBeta(undefined, null).length).toBeGreaterThan(0);
  });

  // ── claude-api-protocol-fidelity (R5): NO whitelist — any flag passes. ────
  it('an arbitrary FUTURE flag is forwarded unfiltered (official protocol forbids whitelists)', () => {
    const out = buildAnthropicBeta('claude-sonnet-4-5', 'claude-code-20990101').split(',');
    expect(out).toContain('claude-code-20990101');
    // Baseline flags stay alongside the caller's, order-stable, deduped.
    expect(out).toContain('oauth-2025-04-20');
    expect(out.filter((f) => f === 'claude-code-20990101')).toHaveLength(1);
  });

  it('the oauth-2025-04-20 baseline survives when the caller sends unknown flags (subscription pin)', () => {
    const out = buildAnthropicBeta('claude-haiku-4-5', 'some-brand-new-2099-flag').split(',');
    expect(out).toContain('oauth-2025-04-20');
    expect(out).toContain('some-brand-new-2099-flag');
  });
});

describe('fillMissingHeaders', () => {
  it('fills only empty slots — an existing value always wins', () => {
    const headers: Record<string, string> = { 'user-agent': 'real-client/9' };
    fillMissingHeaders(headers, DEFAULT_CLAUDE_CODE_HEADERS);
    expect(headers['user-agent']).toBe('real-client/9');
    expect(headers['x-app']).toBe('cli');
  });

  it('is case-insensitive, so an auth header is never shadowed', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer REAL' };
    fillMissingHeaders(headers, { authorization: 'Bearer FAKE' });
    expect(headers['Authorization']).toBe('Bearer REAL');
    expect(headers['authorization']).toBeUndefined();
  });

  it('the default bag supplies a complete Claude Code identity', () => {
    const headers: Record<string, string> = {};
    fillMissingHeaders(headers, DEFAULT_CLAUDE_CODE_HEADERS);
    fillMissingHeaders(headers, { 'anthropic-version': DEFAULT_ANTHROPIC_VERSION });
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['user-agent']).toMatch(/^claude-cli\//);
    expect(headers['x-app']).toBe('cli');
    expect(Object.keys(headers).filter((k) => k.startsWith('x-stainless-')).length).toBeGreaterThan(0);
  });

  it('a caller value beats the default, and the default fills the rest', () => {
    const headers: Record<string, string> = {};
    fillMissingHeaders(headers, { 'user-agent': 'claude-cli/2.1.223 (external, cli)' });
    fillMissingHeaders(headers, DEFAULT_CLAUDE_CODE_HEADERS);
    expect(headers['user-agent']).toBe('claude-cli/2.1.223 (external, cli)');
    expect(headers['x-stainless-lang']).toBe('js');
  });
});
