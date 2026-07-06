/**
 * Unit tests for outbound API server config default / normalize / merge
 * (`outbound-api-server`, model-kind-mapping contract). The persisted shape is
 * heterogeneous by endpoint class and there is NO legacy migration — normalize
 * drops legacy/unknown fields (incl. `visionModel`) and fills blanks.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONCURRENCY_QUEUE,
  DEFAULT_USER_MESSAGE_QUEUE,
  defaultServerConfig,
  mergeServerConfig,
  normalizeServerConfig,
} from '../apiServerConfig';
import type { EndpointRoutingConfig, OutboundApiServerConfig, OutboundEndpoint } from '../types';

function endpoint(
  config: OutboundApiServerConfig,
  ep: OutboundEndpoint,
): EndpointRoutingConfig {
  const found = config.endpoints.find((e) => e.endpoint === ep);
  if (!found) throw new Error(`missing endpoint ${ep}`);
  return found;
}

describe('defaultServerConfig — endpoint-aware blanks', () => {
  it('kind-mapped endpoints carry a blank declared-kind modelMap and no default/background', () => {
    const config = defaultServerConfig();
    const messages = endpoint(config, 'messages');
    expect(messages.modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });
    expect(messages).not.toHaveProperty('defaultModel');
    expect(messages).not.toHaveProperty('backgroundModel');
    expect(messages).not.toHaveProperty('visionModel');

    const responses = endpoint(config, 'responses');
    expect(responses.modelMap).toEqual({ codex: '', mini: '' });
  });

  it('the list-mapped chat endpoint carries an empty models list only', () => {
    const config = defaultServerConfig();
    const chat = endpoint(config, 'chat');
    expect(chat.models).toEqual([]);
    expect(chat).not.toHaveProperty('defaultModel');
    expect(chat).not.toHaveProperty('backgroundModel');
    expect(chat).not.toHaveProperty('modelMap');
    expect(chat).not.toHaveProperty('visionModel');
  });

  it('the role-based gemini endpoint carries blank default/background and no modelMap', () => {
    const config = defaultServerConfig();
    const gemini = endpoint(config, 'gemini');
    expect(gemini.defaultModel).toBe('');
    expect(gemini.backgroundModel).toBe('');
    expect(gemini).not.toHaveProperty('modelMap');
    expect(gemini).not.toHaveProperty('visionModel');
  });

  it('is disabled, loopback, four endpoints', () => {
    const config = defaultServerConfig();
    expect(config.enabled).toBe(false);
    expect(config.networkBinding).toBe(false);
    expect(config.endpoints).toHaveLength(4);
  });
});

describe('normalizeServerConfig — no migration', () => {
  it('drops legacy visionModel and legacy default/background on a kind-mapped endpoint WITHOUT remap', () => {
    const raw = {
      enabled: true,
      networkBinding: false,
      endpoints: [
        {
          endpoint: 'messages',
          // legacy role-based fields that must be DROPPED (no remap into a kind)
          defaultModel: 'legacy-provider,legacy-default',
          backgroundModel: 'legacy-provider,legacy-bg',
          visionModel: 'legacy-provider,legacy-vision',
          useSubscription: true,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const messages = endpoint(normalizeServerConfig(raw), 'messages');
    // filled blank kinds, NOT the legacy default/background values
    expect(messages.modelMap).toEqual({ fable: '', opus: '', sonnet: '', haiku: '' });
    expect(messages).not.toHaveProperty('defaultModel');
    expect(messages).not.toHaveProperty('backgroundModel');
    expect(messages).not.toHaveProperty('visionModel');
    expect(messages.useSubscription).toBe(true);
  });

  it('drops unknown kind keys and coerces non-string refs to blank on a kind-mapped endpoint', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'messages',
          modelMap: { opus: 'p,opus', bogus: 'x', haiku: 42 },
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const messages = endpoint(normalizeServerConfig(raw), 'messages');
    expect(messages.modelMap).toEqual({ fable: '', opus: 'p,opus', sonnet: '', haiku: '' });
    expect(messages.modelMap).not.toHaveProperty('bogus');
  });

  it('drops modelMap and keeps default/background (+ array backgroundModelIds) on the role-based gemini endpoint', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'gemini',
          defaultModel: 'p,default',
          backgroundModel: 'p,bg',
          backgroundModelIds: ['p,small'],
          // stray modelMap on a role-based endpoint must be dropped
          modelMap: { opus: 'nope' },
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const gemini = endpoint(normalizeServerConfig(raw), 'gemini');
    expect(gemini.defaultModel).toBe('p,default');
    expect(gemini.backgroundModel).toBe('p,bg');
    expect(gemini.backgroundModelIds).toEqual(['p,small']);
    expect(gemini).not.toHaveProperty('modelMap');
  });

  it('chat keeps only string list entries and drops legacy role fields (no migration)', () => {
    const raw = {
      endpoints: [
        {
          endpoint: 'chat',
          models: ['p,gpt-4o', '', 42, 'p,glm-4.7'],
          // legacy role-based fields must be DROPPED (no remap into the list)
          defaultModel: 'p,default',
          backgroundModel: 'p,bg',
          backgroundModelIds: ['p,small'],
          useSubscription: false,
        },
      ],
    } as unknown as Partial<OutboundApiServerConfig>;

    const chat = endpoint(normalizeServerConfig(raw), 'chat');
    expect(chat.models).toEqual(['p,gpt-4o', 'p,glm-4.7']);
    expect(chat).not.toHaveProperty('defaultModel');
    expect(chat).not.toHaveProperty('backgroundModel');
    expect(chat).not.toHaveProperty('backgroundModelIds');
  });

  it('missing/blank raw → full default shape', () => {
    expect(normalizeServerConfig(undefined)).toEqual(defaultServerConfig());
    expect(normalizeServerConfig(null)).toEqual(defaultServerConfig());
  });
});

describe('mergeServerConfig', () => {
  it('round-trips through normalize and applies the patch', () => {
    const current = defaultServerConfig();
    const merged = mergeServerConfig(current, { enabled: true, networkBinding: true });
    expect(merged.enabled).toBe(true);
    expect(merged.networkBinding).toBe(true);
    // endpoints preserved in the normalized heterogeneous shape
    expect(endpoint(merged, 'messages').modelMap).toEqual({
      fable: '',
      opus: '',
      sonnet: '',
      haiku: '',
    });
    expect(endpoint(merged, 'chat').models).toEqual([]);
    expect(endpoint(merged, 'gemini').defaultModel).toBe('');
  });

  it('patched endpoints are re-normalized (legacy fields dropped)', () => {
    const current = defaultServerConfig();
    const patchedEndpoints = [
      {
        endpoint: 'messages',
        modelMap: { opus: 'p,opus' },
        visionModel: 'legacy',
        useSubscription: false,
      },
    ] as unknown as EndpointRoutingConfig[];
    const merged = mergeServerConfig(current, { endpoints: patchedEndpoints });
    const messages = endpoint(merged, 'messages');
    expect(messages.modelMap).toEqual({ fable: '', opus: 'p,opus', sonnet: '', haiku: '' });
    expect(messages).not.toHaveProperty('visionModel');
  });
});
