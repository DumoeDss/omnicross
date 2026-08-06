import type { OutboundApiServerConfig } from '@omnicross/core/outbound-api';
import { describe, expect, it } from 'vitest';

import { validateGatewayBindingsSegment } from '../gatewayBindingBody';

function patch(bindings: unknown): Partial<OutboundApiServerConfig> {
  return { bindings } as unknown as Partial<OutboundApiServerConfig>;
}

describe('validateGatewayBindingsSegment', () => {
  it('leaves an omitted segment untouched and accepts every target kind', () => {
    expect(validateGatewayBindingsSegment({})).toEqual([]);
    expect(validateGatewayBindingsSegment(patch([
      {
        id: 'account',
        name: 'Account',
        enabled: true,
        endpoint: 'responses',
        target: { kind: 'account', providerId: 'codex', accountId: 'acct-a' },
        fallback: 'fail',
        modelMap: { codex: 'gpt-5.6-sol' },
      },
      {
        id: 'group',
        name: 'Group',
        enabled: true,
        endpoint: 'messages',
        keyScope: 'selected',
        modelMode: 'mapped',
        modelMappings: [{ source: 'claude-sonnet-*', target: 'glm-4.7' }],
        target: { kind: 'account-group', providerId: 'claude', group: 'team' },
        // 'global' is the pre-migration spelling of 'next' — still accepted.
        fallback: 'global',
        modelMap: { sonnet: 'claude-sonnet-4-5' },
      },
      {
        id: 'provider',
        name: 'Provider',
        enabled: false,
        endpoint: 'chat',
        apiKeyIds: ['client-a'],
        priority: 5,
        target: { kind: 'provider', providerId: 'openai', keyId: 'pool-key-a' },
        fallback: 'fail',
        models: ['gpt-5.6-sol'],
      },
    ]))).toEqual([]);
  });

  it('rejects a non-array segment and enforces the collection bound', () => {
    expect(validateGatewayBindingsSegment(patch(null))).toEqual(['bindings must be an array']);
    expect(validateGatewayBindingsSegment(patch(new Array(1_001).fill(null)))).toEqual([
      'bindings cannot contain more than 1000 entries',
    ]);
  });

  it('reports duplicate ids, invalid scalar fields, and malformed targets', () => {
    const errors = validateGatewayBindingsSegment(patch([
      {
        id: 'same',
        name: '',
        enabled: 'yes',
        endpoint: 'unknown',
        priority: -1,
        fallback: 'pool',
        keyScope: 'some',
        modelMode: 'automatic',
        modelMappings: [{ source: '', target: '' }],
        apiKeyIds: [''],
        target: { kind: 'account', providerId: '', accountId: '' },
      },
      {
        id: 'same',
        name: 'Second',
        enabled: true,
        endpoint: 'chat',
        fallback: 'fail',
        target: { kind: 'provider', providerId: 'openai', keyId: '' },
      },
    ]));

    expect(errors).toEqual(expect.arrayContaining([
      'bindings[0].name is required',
      'bindings[0].enabled must be boolean',
      'bindings[0].endpoint is invalid',
      'bindings[0].fallback must be next or fail',
      'bindings[0].priority must be an integer from 0 to 10000',
      'bindings[0].apiKeyIds must be an array of non-empty strings',
      'bindings[0].keyScope must be all or selected',
      'bindings[0].modelMode must be passthrough or mapped',
      'bindings[0].modelMappings must contain non-empty source and target strings',
      'bindings[0].target.providerId is required',
      'bindings[0].target.accountId is required',
      'bindings[1].id must be unique',
      'bindings[1].target.keyId must be a non-empty string',
    ]));
  });

  it('validates model collections without requiring fields for another endpoint class', () => {
    const errors = validateGatewayBindingsSegment(patch([
      {
        id: 'models',
        name: 'Models',
        enabled: true,
        endpoint: 'gemini',
        fallback: 'fail',
        target: { kind: 'provider', providerId: 'google' },
        modelMap: { default: 42 },
        models: ['ok', ''],
        backgroundModelIds: 'not-an-array',
        defaultModel: 42,
      },
    ]));
    expect(errors).toEqual([
      'bindings[0].modelMap must contain string values',
      'bindings[0].models must be an array of non-empty strings',
      'bindings[0].backgroundModelIds must be an array of non-empty strings',
      'bindings[0].defaultModel must be a string',
    ]);
  });
});
