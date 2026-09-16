/**
 * chatgpt-web command tests: the Codex `-c` override wiring (pure argv shape).
 *
 * @module @omnicross/daemon/commands/__tests__/chatgpt-web.test
 */

import { describe, expect, it } from 'vitest';

import { buildChatGptWebConfigOverrides, CHATGPT_WEB_TOKEN_ENV } from '../chatgpt-web';

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
