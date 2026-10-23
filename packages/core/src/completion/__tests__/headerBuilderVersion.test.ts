/**
 * Version header fidelity (`claude-api-protocol-fidelity`, R5): the
 * Anthropic wire uses the documented protocol version.
 *
 * @module completion/__tests__/headerBuilderVersion.test
 */

import { describe, expect, it } from 'vitest';

import { getProviderHeaders } from '../header-builder';

const ANTHROPIC_PROVIDER = {
  id: 'anth',
  name: 'Anthropic',
  api_base_url: 'https://api.anthropic.com',
  api_key: 'sk-x',
  models: ['claude-x'],
  enabled: true,
  apiFormat: 'anthropic',
} as Parameters<typeof getProviderHeaders>[0];

describe('getProviderHeaders anthropic version default (R5)', () => {
  it('sends the official documented version 2023-06-01', () => {
    expect(getProviderHeaders(ANTHROPIC_PROVIDER, 'sk-x')['anthropic-version']).toBe('2023-06-01');
  });

});
