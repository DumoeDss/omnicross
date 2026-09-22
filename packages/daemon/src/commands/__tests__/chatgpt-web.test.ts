/**
 * chatgpt-web command tests: the Codex `-c` override wiring (pure argv shape).
 *
 * @module @omnicross/daemon/commands/__tests__/chatgpt-web.test
 */

import { describe, expect, it } from 'vitest';

import { buildChatGptWebConfigOverrides, buildCodexCommand, CHATGPT_WEB_TOKEN_ENV } from '../chatgpt-web';

describe('buildChatGptWebConfigOverrides', () => {
  it('points a dedicated provider at the bridge /v1 base with responses wire API', () => {
    const overrides = buildChatGptWebConfigOverrides('http://127.0.0.1:17850');
    expect(overrides).toEqual([
      '-c',
      'model_provider="omnicross-chatgptweb"',
      '-c',
      'model_providers.omnicross-chatgptweb.name="OmniCross ChatGPT Web (experimental)"',
      '-c',
      'model_providers.omnicross-chatgptweb.base_url="http://127.0.0.1:17850/v1"',
      '-c',
      'model_providers.omnicross-chatgptweb.wire_api="responses"',
      '-c',
      `model_providers.omnicross-chatgptweb.env_key="${CHATGPT_WEB_TOKEN_ENV}"`,
      '-c',
      'disable_response_storage=true',
    ]);
  });

  it('uses a provider name distinct from the resident proxy provider', () => {
    const overrides = buildChatGptWebConfigOverrides('http://127.0.0.1:1');
    expect(overrides.join(' ')).not.toContain('model_provider="omnicross"');
  });
});

describe('buildCodexCommand', () => {
  const base = { token: 'tok', baseUrl: 'http://127.0.0.1:17850', model: 'chatgpt-web/high' };

  // PowerShell requires the assignment to stand as its own statement —
  // `$env:VAR="…" codex …` (no `;`) is a parse error, which is exactly what
  // the shipped command produced.
  it('windows: ;-separated PowerShell statement assignment', () => {
    const command = buildCodexCommand({ ...base, platform: 'win32' });
    expect(command.startsWith(`$env:${CHATGPT_WEB_TOKEN_ENV}="tok"; codex -c `)).toBe(true);
    expect(command.endsWith('-m chatgpt-web/high')).toBe(true);
  });

  // POSIX one-shot prefix assignment — `export VAR="…" codex …` would EXPORT
  // the trailing words and never run codex.
  it('posix: one-shot prefix assignment, no export', () => {
    const command = buildCodexCommand({ ...base, platform: 'linux' });
    expect(command.startsWith(`${CHATGPT_WEB_TOKEN_ENV}="tok" codex -c `)).toBe(true);
    expect(command).not.toContain('export ');
  });
});
