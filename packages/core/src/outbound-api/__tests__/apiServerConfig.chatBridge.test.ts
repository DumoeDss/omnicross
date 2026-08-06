/**
 * apiServerConfig normalization for the OpenAI-chat bridge (openai-chat-bridge
 * #11). The `chat` endpoint gains an opt-in `dispatchMode` + `prefixTargets`:
 *  - default / absent / any non-'prefix' value ⇒ list mode; the normalized chat
 *    block stays byte-identical to before this change (zero regression).
 *  - `'prefix'` ⇒ carried, with `prefixTargets` cleaned to the three known
 *    prefixes' non-blank string refs.
 */
import { describe, expect, it } from 'vitest';

import { normalizeEndpointConfig, normalizePrefixTargets } from '../apiServerConfig';
import type { EndpointRoutingConfig } from '../types';

/** Normalize ONE raw chat block — the shape a downstream route carries. */
function chatOf(chat: Record<string, unknown>): EndpointRoutingConfig {
  return normalizeEndpointConfig(chat as unknown as EndpointRoutingConfig);
}

describe('normalizeEndpointConfig — chat dispatchMode (default list)', () => {
  it('a list-mode chat block stays byte-identical (no dispatchMode / prefixTargets keys)', () => {
    const chat = chatOf({ endpoint: 'chat', models: ['pa,gpt-4o'], useSubscription: false });
    expect(chat).toEqual({ endpoint: 'chat', models: ['pa,gpt-4o'], useSubscription: false });
    expect(chat).not.toHaveProperty('dispatchMode');
    expect(chat).not.toHaveProperty('prefixTargets');
  });

  it('an unknown dispatchMode value is dropped (⇒ list)', () => {
    const chat = chatOf({
          endpoint: 'chat',
          models: [],
          useSubscription: false,
          dispatchMode: 'bogus',
          prefixTargets: { claude: 'c,c' },
        });
    expect(chat).not.toHaveProperty('dispatchMode');
    expect(chat).not.toHaveProperty('prefixTargets');
  });

  it('dispatchMode "prefix" is carried with cleaned prefixTargets', () => {
    const chat = chatOf({
          endpoint: 'chat',
          models: [],
          useSubscription: true,
          dispatchMode: 'prefix',
          prefixTargets: {
            claude: '  claude,claude-sonnet-4-5  ',
            gpt: 'openai,gpt-4o',
            gemini: '', // blank dropped
            bogus: 'x,y', // unknown prefix dropped
          },
        });
    expect(chat.dispatchMode).toBe('prefix');
    expect(chat.prefixTargets).toEqual({
      claude: 'claude,claude-sonnet-4-5',
      gpt: 'openai,gpt-4o',
    });
    expect(chat.prefixTargets).not.toHaveProperty('gemini');
    expect(chat.prefixTargets).not.toHaveProperty('bogus');
  });

  it('dispatchMode "prefix" with no valid targets carries the mode but omits prefixTargets', () => {
    const chat = chatOf({
          endpoint: 'chat',
          models: [],
          useSubscription: false,
          dispatchMode: 'prefix',
          prefixTargets: { gemini: '   ' },
        });
    expect(chat.dispatchMode).toBe('prefix');
    expect(chat).not.toHaveProperty('prefixTargets');
  });
});

describe('normalizePrefixTargets', () => {
  it('keeps only the three known prefixes with non-blank trimmed refs', () => {
    expect(
      normalizePrefixTargets({ claude: ' a,b ', gpt: 'c,d', gemini: '', other: 'e,f' }),
    ).toEqual({ claude: 'a,b', gpt: 'c,d' });
  });
  it('returns undefined for a non-object or empty result', () => {
    expect(normalizePrefixTargets(undefined)).toBeUndefined();
    expect(normalizePrefixTargets(null)).toBeUndefined();
    expect(normalizePrefixTargets('x')).toBeUndefined();
    expect(normalizePrefixTargets({ gemini: '  ' })).toBeUndefined();
  });
});
