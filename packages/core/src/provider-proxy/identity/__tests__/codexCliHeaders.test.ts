/**
 * codexCliHeaders tests — the Codex CLI client markers the codex SUBSCRIPTION
 * relay puts on every `chatgpt.com/backend-api/codex/responses` request.
 *
 * The regression under guard: verified against a live `upstream-trace.jsonl`,
 * this relay sent ONLY `content-type` + `Authorization` — none of the markers a
 * real `codex` CLI carries. Unlike the claude path it still got a 200, so the
 * risk here is silent (looking nothing like the client it claims to be) rather
 * than a hard failure.
 *
 * 2026-09-14: the session-id/thread-id header spellings the current CLI sends
 * (hyphen) are load-bearing — ChatGPT's backend derives Responses
 * prefix-cache affinity from the `session-id` HEADER (codex #44862) — so
 * forwarding them, and mirroring the body prompt_cache_key into the header
 * for callers that send none, is under guard here too.
 */

import { describe, expect, it } from 'vitest';

import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  ensureCodexSessionIdHeader,
  extractCodexClientHeaders,
  fillMissingCodexCliIdentity,
} from '../codexCliHeaders';
import { fillMissingHeaders } from '../headerMerge';

describe('extractCodexClientHeaders', () => {
  it('forwards the Codex CLI markers, lowercased', () => {
    expect(
      extractCodexClientHeaders({
        Originator: 'codex_cli_rs',
        'User-Agent': 'codex_cli_rs/0.150.0',
        Version: '0.150.0',
        'OpenAI-Beta': 'responses=v1',
        session_id: 'sess-abc',
      }),
    ).toEqual({
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.150.0',
      version: '0.150.0',
      'openai-beta': 'responses=v1',
      session_id: 'sess-abc',
    });
  });

  it('NEVER forwards auth / cookie / transport headers', () => {
    const out = extractCodexClientHeaders({
      authorization: 'Bearer SECRET-TOKEN',
      cookie: 'session=SECRET',
      'x-api-key': 'sk-SECRET',
      host: 'evil.example',
      'content-length': '99',
      originator: 'codex_cli_rs',
    });
    expect(out).toEqual({ originator: 'codex_cli_rs' });
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('ignores headers outside the allow-list', () => {
    expect(extractCodexClientHeaders({ 'x-random': 'v', 'anthropic-beta': 'x' })).toEqual({});
  });

  it('forwards the hyphenated session-id/thread-id the current Codex CLI sends (cache affinity)', () => {
    // codex-rs build_session_headers emits `session-id` / `thread-id`; ChatGPT
    // derives Responses prefix-cache affinity from the session-id HEADER
    // (codex #44862). The old allow-list carried only the underscore spelling,
    // so the real headers were silently dropped.
    expect(
      extractCodexClientHeaders({
        'Session-Id': 'sess-hyphen',
        'Thread-Id': 'thread-hyphen',
      }),
    ).toEqual({
      'session-id': 'sess-hyphen',
      'thread-id': 'thread-hyphen',
    });
  });

  it('forwards both spellings when a caller sends both (fill-only merge, no clobber)', () => {
    expect(
      extractCodexClientHeaders({
        'session-id': 'sess-hyphen',
        session_id: 'sess-underscore',
        'thread-id': 'thread-hyphen',
        thread_id: 'thread-underscore',
      }),
    ).toEqual({
      'session-id': 'sess-hyphen',
      session_id: 'sess-underscore',
      'thread-id': 'thread-hyphen',
      thread_id: 'thread-underscore',
    });
  });

  it('NEVER-set still wins alongside forwardable session headers', () => {
    expect(
      extractCodexClientHeaders({
        Authorization: 'Bearer SECRET',
        'session-id': 'sess-1',
        'thread-id': 'thread-1',
      }),
    ).toEqual({ 'session-id': 'sess-1', 'thread-id': 'thread-1' });
  });
});

describe('ensureCodexSessionIdHeader (header-level cache affinity, codex #44862)', () => {
  it('mirrors the body prompt_cache_key into session-id when the caller sent none', () => {
    const headers: Record<string, string> = {};
    ensureCodexSessionIdHeader(headers, { prompt_cache_key: 'omnicross:session-header:abc123' });
    expect(headers['session-id']).toBe('omnicross:session-header:abc123');
  });

  it('never overrides a caller-provided session-id', () => {
    const headers: Record<string, string> = { 'session-id': 'caller-session' };
    ensureCodexSessionIdHeader(headers, { prompt_cache_key: 'omnicross:content-fingerprint:xyz' });
    expect(headers['session-id']).toBe('caller-session');
  });

  it('is a no-op without a usable prompt_cache_key', () => {
    const headers: Record<string, string> = {};
    ensureCodexSessionIdHeader(headers, {});
    ensureCodexSessionIdHeader(headers, { prompt_cache_key: '   ' });
    ensureCodexSessionIdHeader(headers, { prompt_cache_key: 42 });
    expect(headers).toEqual({});
  });
});

describe('codex outbound header assembly', () => {
  it('a bare caller still gets a full Codex CLI identity', () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer REAL',
      'content-type': 'application/json',
    };
    fillMissingHeaders(headers, {});
    fillMissingHeaders(headers, { accept: codexAcceptHeader(true) });
    fillMissingCodexCliIdentity(headers);

    expect(headers['originator']).toBe('codex_cli_rs');
    expect(headers['user-agent']).toMatch(/^codex_cli_rs\//);
    expect(headers['version']).toBeDefined();
    // The synthetic persona is coherent: UA and version name the same CLI.
    expect(headers['user-agent']).toBe(`codex_cli_rs/${headers['version']}`);
    expect(headers['accept']).toBe('text/event-stream');
    // The auth header the strategy set is untouched, and never duplicated.
    expect(headers['Authorization']).toBe('Bearer REAL');
    expect(headers['authorization']).toBeUndefined();
  });

  it("a real Codex CLI's own values win over the defaults", () => {
    const headers: Record<string, string> = {};
    fillMissingHeaders(headers, {
      'user-agent': 'codex_cli_rs/0.150.0',
      version: '0.150.0',
      session_id: 'sess-xyz',
    });
    fillMissingCodexCliIdentity(headers);

    expect(headers['user-agent']).toBe('codex_cli_rs/0.150.0');
    expect(headers['version']).toBe('0.150.0');
    expect(headers['session_id']).toBe('sess-xyz');
    // ...and a marker the caller omitted is still filled.
    expect(headers['originator']).toBe('codex_cli_rs');
  });

  it('NEVER fabricates a `version` under a caller-provided user-agent (2026-09 gpt-6-astra gate)', () => {
    // The incident shape exactly: a real Codex CLI on a CUSTOM provider sends
    // its user-agent but no `version` (the CLI attaches `version` only to the
    // built-in openai provider). The old unconditional fill pinned a stale
    // 0.144.5 under this 0.153.4 UA and the backend's per-model
    // minimum-client-version gate rejected gpt-6-astra with
    // "requires a newer version of Codex". The header must stay ABSENT.
    const headers: Record<string, string> = { Authorization: 'Bearer REAL' };
    fillMissingHeaders(headers, {
      'user-agent': 'codex-tui/0.153.4 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.153.4)',
    });
    fillMissingCodexCliIdentity(headers);

    expect(headers['version']).toBeUndefined();
    expect(headers['user-agent']).toContain('codex-tui/0.153.4');
    // The load-bearing routing marker is still filled.
    expect(headers['originator']).toBe('codex_cli_rs');
    // ...and no value from the synthetic persona leaked in.
    expect(Object.values(headers)).not.toContain(DEFAULT_CODEX_CLI_HEADERS['user-agent']);
  });

  it('treats an explicitly sent `version` under a caller UA as authoritative', () => {
    const headers: Record<string, string> = {};
    fillMissingHeaders(headers, {
      'user-agent': 'codex_cli_rs/0.150.0',
      version: '0.150.0',
    });
    fillMissingCodexCliIdentity(headers);
    expect(headers['version']).toBe('0.150.0');
  });

  it('detects the caller user-agent case-insensitively', () => {
    const headers: Record<string, string> = { 'User-Agent': 'codex_vscode/0.153.4' };
    fillMissingCodexCliIdentity(headers);
    expect(headers['version']).toBeUndefined();
    expect(headers['originator']).toBe('codex_cli_rs');
  });

  it('accept follows the streaming mode', () => {
    expect(codexAcceptHeader(true)).toBe('text/event-stream');
    expect(codexAcceptHeader(false)).toBe('application/json');
  });

  it('keeps the synthetic persona internally coherent (module contract)', () => {
    expect(DEFAULT_CODEX_CLI_HEADERS['user-agent']).toBe(
      `codex_cli_rs/${DEFAULT_CODEX_CLI_HEADERS['version']}`,
    );
  });
});
