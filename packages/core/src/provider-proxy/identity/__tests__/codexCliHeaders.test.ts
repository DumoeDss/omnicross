/**
 * codexCliHeaders tests — the Codex CLI client markers the codex SUBSCRIPTION
 * relay puts on every `chatgpt.com/backend-api/codex/responses` request.
 *
 * The regression under guard: verified against a live `upstream-trace.jsonl`,
 * this relay sent ONLY `content-type` + `Authorization` — none of the markers a
 * real `codex` CLI carries. Unlike the claude path it still got a 200, so the
 * risk here is silent (looking nothing like the client it claims to be) rather
 * than a hard failure.
 */

import { describe, expect, it } from 'vitest';

import {
  codexAcceptHeader,
  DEFAULT_CODEX_CLI_HEADERS,
  extractCodexClientHeaders,
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
});

describe('codex outbound header assembly', () => {
  it('a bare caller still gets a full Codex CLI identity', () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer REAL',
      'content-type': 'application/json',
    };
    fillMissingHeaders(headers, {});
    fillMissingHeaders(headers, DEFAULT_CODEX_CLI_HEADERS);
    fillMissingHeaders(headers, { accept: codexAcceptHeader(true) });

    expect(headers['originator']).toBe('codex_cli_rs');
    expect(headers['user-agent']).toMatch(/^codex_cli_rs\//);
    expect(headers['version']).toBeDefined();
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
    fillMissingHeaders(headers, DEFAULT_CODEX_CLI_HEADERS);

    expect(headers['user-agent']).toBe('codex_cli_rs/0.150.0');
    expect(headers['version']).toBe('0.150.0');
    expect(headers['session_id']).toBe('sess-xyz');
    // ...and a marker the caller omitted is still filled from the defaults.
    expect(headers['originator']).toBe('codex_cli_rs');
  });

  it('accept follows the streaming mode', () => {
    expect(codexAcceptHeader(true)).toBe('text/event-stream');
    expect(codexAcceptHeader(false)).toBe('application/json');
  });
});
