/**
 * upstreamRouting.test.ts — the derivation layer of the upstream routing
 * model: per-key ordered upstream sets + upstream-level mapping tables →
 * internal GatewayBinding rows the existing resolver consumes unchanged.
 */

import { describe, expect, it } from 'vitest';

import {
  assembleGatewayBindings,
  deriveKeyUpstreamBindings,
  upstreamBindingTargets,
} from '../upstreamRouting';
import {
  candidateGatewayBindings,
  resolveGatewayBinding,
} from '../gatewayBindingResolver';
import type {
  GatewayBinding,
  GatewayBindingTarget,
  GatewayModelMapping,
  KeyUpstreamBinding,
} from '../types';

const DEEPSEEK: GatewayBindingTarget = { kind: 'provider', providerId: 'deepseek' };
const CLAUDE_POOL: GatewayBindingTarget = { kind: 'account-pool', providerId: 'claude' };
const GLM: GatewayBindingTarget = { kind: 'provider', providerId: 'glm' };

const ALL_UPSTREAMS: GatewayBindingTarget[] = [DEEPSEEK, CLAUDE_POOL, GLM];

function mappingsFor(
  table: Partial<Record<string, GatewayModelMapping[]>>,
): (target: GatewayBindingTarget) => GatewayModelMapping[] | undefined {
  return (target) => (target.kind === 'provider' ? table[target.providerId] : undefined);
}

describe('deriveKeyUpstreamBindings', () => {
  it('derives one scoped binding per (target, endpoint) with list order as priority', () => {
    const bindings = deriveKeyUpstreamBindings({
      apiKeyId: 'k1',
      upstreamBinding: { mode: 'explicit', targets: [DEEPSEEK, CLAUDE_POOL] },
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => undefined,
    });
    // 2 targets × 4 endpoints, ids stable and route-pin compatible.
    expect(bindings).toHaveLength(8);
    const chat = bindings.filter((b) => b.endpoint === 'chat');
    expect(chat.map((b) => b.priority)).toEqual([0, 1]);
    expect(chat.map((b) => b.target)).toEqual([DEEPSEEK, CLAUDE_POOL]);
    for (const binding of bindings) {
      expect(binding.keyScope).toBe('selected');
      expect(binding.apiKeyIds).toEqual(['k1']);
      expect(binding.fallback).toBe('next');
      expect(binding.enabled).toBe(true);
      expect(binding.modelMode).toBe('passthrough');
    }
    expect(new Set(bindings.map((b) => b.id))).toEqual(
      new Set([
        'keyup:k1:0:chat', 'keyup:k1:0:responses', 'keyup:k1:0:messages', 'keyup:k1:0:gemini',
        'keyup:k1:1:chat', 'keyup:k1:1:responses', 'keyup:k1:1:messages', 'keyup:k1:1:gemini',
      ]),
    );
  });

  it("mode 'all' expands to the live upstream catalog; explicit empty binds nothing", () => {
    const all = deriveKeyUpstreamBindings({
      apiKeyId: 'k1',
      upstreamBinding: { mode: 'all' },
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => undefined,
    });
    expect(all).toHaveLength(ALL_UPSTREAMS.length * 4);

    const none = deriveKeyUpstreamBindings({
      apiKeyId: 'k1',
      upstreamBinding: { mode: 'explicit', targets: [] },
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => undefined,
    });
    expect(none).toEqual([]);
    expect(upstreamBindingTargets({ mode: 'explicit', targets: [] }, ALL_UPSTREAMS)).toEqual([]);
    expect(upstreamBindingTargets({ mode: 'all' }, ALL_UPSTREAMS)).toEqual(ALL_UPSTREAMS);
  });

  it('carries the upstream mapping table as name rows; no table = passthrough', () => {
    const bindings = deriveKeyUpstreamBindings({
      apiKeyId: 'k1',
      upstreamBinding: { mode: 'explicit', targets: [GLM, DEEPSEEK] },
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: mappingsFor({
        glm: [
          { source: 'claude-*', target: 'glm-4.7' },
          { source: 'gpt-4o', target: 'glm-4.6' },
        ],
      }),
    });
    const glmChat = bindings.find((b) => b.id === 'keyup:k1:0:chat');
    expect(glmChat?.modelMode).toBe('mapped');
    expect(glmChat?.modelMappings).toEqual([
      { source: 'claude-*', target: 'glm-4.7' },
      { source: 'gpt-4o', target: 'glm-4.6' },
    ]);
    // No table ⇒ passthrough (any non-blank model name serves).
    const deepseekChat = bindings.find((b) => b.id === 'keyup:k1:1:chat');
    expect(deepseekChat?.modelMode).toBe('passthrough');
    expect(deepseekChat?.modelMappings).toBeUndefined();
  });

  it('projects role-keyed rows onto the gemini endpoint only', () => {
    const bindings = deriveKeyUpstreamBindings({
      apiKeyId: 'k1',
      upstreamBinding: { mode: 'explicit', targets: [GLM] },
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => [
        { source: 'default', target: 'gemini-pro' },
        { source: 'background', target: 'gemini-flash' },
        { source: 'gemini-flash-lite', target: 'gemini-flash' },
      ],
    });
    const gemini = bindings.find((b) => b.endpoint === 'gemini');
    expect(gemini?.modelMode).toBe('mapped');
    expect(gemini?.defaultModel).toBe('gemini-pro');
    expect(gemini?.backgroundModel).toBe('gemini-flash');
    // Name rows whose target equals the background model feed background detection.
    expect(gemini?.backgroundModelIds).toEqual(['gemini-flash-lite']);
    // Role rows never leak into name matching on other endpoints.
    const chat = bindings.find((b) => b.endpoint === 'chat');
    expect(chat?.modelMode).toBe('mapped');
    expect(chat?.modelMappings).toEqual([
      { source: 'gemini-flash-lite', target: 'gemini-flash' },
    ]);
  });
});

describe('assembleGatewayBindings', () => {
  const legacyRoute = (overrides: Partial<GatewayBinding>): GatewayBinding => ({
    id: 'legacy-1',
    name: 'Legacy',
    enabled: true,
    keyScope: 'all',
    endpoint: 'messages',
    target: GLM,
    priority: 100,
    fallback: 'next',
    modelMode: 'passthrough',
    ...overrides,
  });

  it('migrated keys: derived bindings win, their legacy scoped routes are dropped', () => {
    const assembled = assembleGatewayBindings({
      keys: [{ id: 'k1', upstreamBinding: { mode: 'explicit', targets: [DEEPSEEK] } }],
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => undefined,
      legacyBindings: [
        legacyRoute({ id: 'legacy-k1', keyScope: 'selected', apiKeyIds: ['k1'] }),
        legacyRoute({ id: 'legacy-k2', keyScope: 'selected', apiKeyIds: ['k2'] }),
        legacyRoute({ id: 'legacy-all' }),
      ],
    });
    // k1's legacy route dropped; k2's and the all-scope route kept.
    expect(assembled.some((b) => b.id === 'legacy-k1')).toBe(false);
    expect(assembled.some((b) => b.id === 'legacy-k2')).toBe(true);
    expect(assembled.some((b) => b.id === 'legacy-all')).toBe(true);
    // Derived scoped bindings present.
    expect(assembled.filter((b) => b.id.startsWith('keyup:k1:'))).toHaveLength(4);
  });

  it('the resolver serves a migrated key from its derived list in order, with failover', () => {
    const assembled = assembleGatewayBindings({
      keys: [{ id: 'k1', upstreamBinding: { mode: 'explicit', targets: [CLAUDE_POOL, DEEPSEEK] } }],
      allUpstreams: ALL_UPSTREAMS,
      // claude pool only declares claude-*; deepseek (index 1) is passthrough.
      mappingsFor: mappingsFor({ claude: undefined, deepseek: undefined }),
      legacyBindings: [legacyRoute({ id: 'legacy-all', endpoint: 'chat' })],
    });
    const claudeTable = (t: GatewayBindingTarget): GatewayModelMapping[] | undefined =>
      t.kind === 'account-pool' && t.providerId === 'claude'
        ? [{ source: 'claude-*', target: 'claude-sonnet-4-5' }]
        : undefined;
    const withClaudeMapping = assembleGatewayBindings({
      keys: [{ id: 'k1', upstreamBinding: { mode: 'explicit', targets: [CLAUDE_POOL, DEEPSEEK] } }],
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: claudeTable,
      legacyBindings: [],
    });

    // A claude-* name is served by the first upstream (claude pool).
    const claude = resolveGatewayBinding({
      bindings: withClaudeMapping,
      apiKeyId: 'k1',
      endpoint: 'messages',
      requestedModel: 'claude-sonnet-4-5-20261001',
    });
    expect(claude.source).toBe('binding');
    expect(claude.binding?.target).toEqual(CLAUDE_POOL);

    // A name the claude pool does NOT declare yields to the next upstream
    // (deepseek, passthrough) — can-serve failover (D1).
    const yielded = resolveGatewayBinding({
      bindings: withClaudeMapping,
      apiKeyId: 'k1',
      endpoint: 'messages',
      requestedModel: 'deepseek-chat',
    });
    expect(yielded.source).toBe('binding');
    expect(yielded.binding?.target).toEqual(DEEPSEEK);

    // All-scope legacy routes are suppressed for the migrated key (scoped
    // tier wins) but still serve an unmigrated key.
    expect(candidateGatewayBindings(assembled, 'k1', 'chat')).toHaveLength(2); // derived only
    expect(candidateGatewayBindings(assembled, 'k2', 'chat')).toHaveLength(1); // legacy-all
  });

  it('unmigrated keys keep the legacy semantics untouched', () => {
    const assembled = assembleGatewayBindings({
      keys: [{ id: 'k2' }],
      allUpstreams: ALL_UPSTREAMS,
      mappingsFor: () => undefined,
      legacyBindings: [legacyRoute({ id: 'legacy-k2', keyScope: 'selected', apiKeyIds: ['k2'] })],
    });
    expect(assembled).toHaveLength(1);
    expect(assembled[0]?.id).toBe('legacy-k2');
  });
});
