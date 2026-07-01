/**
 * Unit tests for model-KIND detection + config-completeness validation
 * (`outbound-api-server`, model-kind-mapping contract). Kind detection is
 * version-INDEPENDENT: a versioned client id (`claude-opus-4-8-2026xxxx`)
 * classifies to its kind (`opus`) so CLI upgrades need no reconfig.
 */
import { describe, expect, it } from 'vitest';

import {
  detectModelKind,
  isKindMappedEndpoint,
  modelKindsForEndpoint,
  validateEndpointModelConfig,
  validateServerModelConfig,
} from '../kindDetection';
import type {
  EndpointRoutingConfig,
  OutboundApiServerConfig,
} from '../types';

describe('isKindMappedEndpoint', () => {
  it('true for messages/responses, false for chat/gemini', () => {
    expect(isKindMappedEndpoint('messages')).toBe(true);
    expect(isKindMappedEndpoint('responses')).toBe(true);
    expect(isKindMappedEndpoint('chat')).toBe(false);
    expect(isKindMappedEndpoint('gemini')).toBe(false);
  });
});

describe('modelKindsForEndpoint', () => {
  it('returns the declared kinds per endpoint', () => {
    expect(modelKindsForEndpoint('messages')).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(modelKindsForEndpoint('responses')).toEqual(['codex', 'mini']);
  });
});

describe('detectModelKind — messages (Claude Code)', () => {
  it('versioned opus id → opus (version-independent)', () => {
    expect(detectModelKind('messages', 'claude-opus-4-8-2026xxxx')).toBe('opus');
    expect(detectModelKind('messages', 'claude-opus-4-8[1m]')).toBe('opus');
  });

  it('sonnet / haiku / fable families → their kind', () => {
    expect(detectModelKind('messages', 'claude-sonnet-4-6')).toBe('sonnet');
    expect(detectModelKind('messages', 'claude-3-5-haiku')).toBe('haiku');
    expect(detectModelKind('messages', 'claude-fable-5')).toBe('fable');
  });

  it('publisher-prefixed id still classifies (prefix stripped)', () => {
    expect(detectModelKind('messages', 'anthropic/claude-sonnet-4-6')).toBe('sonnet');
  });

  it('a non-Claude id with no kind token → undefined', () => {
    expect(detectModelKind('messages', 'deepseek-v3')).toBeUndefined();
    expect(detectModelKind('messages', 'gpt-4o')).toBeUndefined();
  });

  it('a token that merely CONTAINS a kind (opusx) does NOT match → undefined', () => {
    // Token-boundary match, not substring: `opusx` ≠ `opus`, so no kind is found.
    expect(detectModelKind('messages', 'claude-opusx-4-8')).toBeUndefined();
    expect(detectModelKind('messages', 'sonnetish-1')).toBeUndefined();
  });

  it('a `:tag` suffix is stripped before classification', () => {
    expect(detectModelKind('messages', 'claude-opus-4:beta')).toBe('opus');
  });

  it('empty / blank / absent id → undefined', () => {
    expect(detectModelKind('messages', '')).toBeUndefined();
    expect(detectModelKind('messages', '   ')).toBeUndefined();
    expect(detectModelKind('messages', undefined)).toBeUndefined();
  });
});

describe('detectModelKind — responses (Codex)', () => {
  it('codex / large ids → codex (else-branch)', () => {
    expect(detectModelKind('responses', 'gpt-5.3-codex')).toBe('codex');
    expect(detectModelKind('responses', 'gpt-5-codex')).toBe('codex');
    expect(detectModelKind('responses', 'gpt-5.5')).toBe('codex');
  });

  it('small-tier ids → mini', () => {
    expect(detectModelKind('responses', 'gpt-4o-mini')).toBe('mini');
    expect(detectModelKind('responses', 'gpt-5-mini')).toBe('mini');
    expect(detectModelKind('responses', 'o4-mini')).toBe('mini');
    expect(detectModelKind('responses', 'gpt-5-nano')).toBe('mini');
  });

  it('codex+mini token collision → mini (mini-precedence over codex)', () => {
    // Any small-tier token wins even alongside a `codex` token, so a future
    // refactor cannot silently flip precedence to the codex else-branch.
    expect(detectModelKind('responses', 'gpt-5-codex-mini')).toBe('mini');
  });

  it('empty / absent id → undefined', () => {
    expect(detectModelKind('responses', '')).toBeUndefined();
    expect(detectModelKind('responses', undefined)).toBeUndefined();
  });
});

// --- config-completeness validation -----------------------------------------

const ref = 'provider,model';

function messagesConfig(map: Record<string, string>): EndpointRoutingConfig {
  return { endpoint: 'messages', modelMap: map, useSubscription: false };
}

describe('validateEndpointModelConfig', () => {
  it('complete kind-mapped endpoint → []', () => {
    expect(
      validateEndpointModelConfig(
        messagesConfig({ fable: ref, opus: ref, sonnet: ref, haiku: ref }),
      ),
    ).toEqual([]);
  });

  it('missing a kind → that kind reported', () => {
    expect(
      validateEndpointModelConfig(messagesConfig({ fable: ref, opus: ref, sonnet: ref })),
    ).toEqual(['haiku']);
  });

  it('blank / whitespace ref counts as missing', () => {
    expect(
      validateEndpointModelConfig(
        messagesConfig({ fable: ref, opus: ref, sonnet: ref, haiku: '   ' }),
      ),
    ).toEqual(['haiku']);
  });

  it('absent modelMap → all declared kinds missing', () => {
    expect(
      validateEndpointModelConfig({ endpoint: 'responses', useSubscription: false }),
    ).toEqual(['codex', 'mini']);
  });

  it('role-based endpoint → [] (no declared kinds)', () => {
    expect(
      validateEndpointModelConfig({
        endpoint: 'chat',
        defaultModel: '',
        backgroundModel: '',
        useSubscription: false,
      }),
    ).toEqual([]);
  });
});

describe('validateServerModelConfig (strict default)', () => {
  const serverConfig = (
    endpoints: EndpointRoutingConfig[],
  ): OutboundApiServerConfig => ({
    enabled: true,
    networkBinding: false,
    endpoints,
    port: 8080,
  });

  const completeMessages = messagesConfig({ fable: ref, opus: ref, sonnet: ref, haiku: ref });
  const completeResponses: EndpointRoutingConfig = {
    endpoint: 'responses',
    modelMap: { codex: ref, mini: ref },
    useSubscription: false,
  };
  const roleChat: EndpointRoutingConfig = {
    endpoint: 'chat',
    defaultModel: ref,
    backgroundModel: ref,
    useSubscription: false,
  };

  it('all kind-mapped endpoints complete → []', () => {
    expect(
      validateServerModelConfig(serverConfig([completeMessages, completeResponses, roleChat])),
    ).toEqual([]);
  });

  it('incomplete responses → one entry with the missing kind', () => {
    const partialResponses: EndpointRoutingConfig = {
      endpoint: 'responses',
      modelMap: { codex: ref },
      useSubscription: false,
    };
    expect(
      validateServerModelConfig(serverConfig([completeMessages, partialResponses])),
    ).toEqual([{ endpoint: 'responses', missingKinds: ['mini'] }]);
  });

  it('an absent kind-mapped endpoint counts as fully missing', () => {
    // Only responses present → messages entirely unconfigured.
    expect(validateServerModelConfig(serverConfig([completeResponses]))).toEqual([
      { endpoint: 'messages', missingKinds: ['fable', 'opus', 'sonnet', 'haiku'] },
    ]);
  });
});
