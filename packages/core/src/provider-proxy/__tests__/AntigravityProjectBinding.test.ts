import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveProject } = vi.hoisted(() => ({ resolveProject: vi.fn(async () => 'project-b') }));
vi.mock('../../auth/GeminiCodeAssistProjectResolver', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../auth/GeminiCodeAssistProjectResolver')>(),
  getAntigravityProjectResolver: () => ({ resolveProject }),
}));

import { AntigravityTransformer } from '../../transformer/transformers/AntigravityTransformer';
import type { AuthApplyHints } from '../../pipeline/SubscriptionAuthStrategy';
import { buildSubscriptionIterationPlan } from '../ingress/anthropicSubscriptionPlan';
import { buildResponsesCallPlan, resolveResponsesRouteProfile } from '../responses/responsesDriver';
import type { ProviderProxyDeps, RouteContext, SubscriptionDispatchProfile } from '../types';

function fixture() {
  const applyHeaders = vi.fn(async (headers: Record<string, string>, hints?: AuthApplyHints) => {
    headers.Authorization = 'Bearer account-b';
    hints?.reportSelection?.('b', false);
  });
  const profile = {
    providerId: 'antigravity', displayName: 'Antigravity', mode: 'transformer',
    authStrategy: { providerId: 'antigravity', kind: 'oauth-bearer', applyHeaders,
      onUnauthorized: async () => false, describeStatus: async () => ({ providerId: 'antigravity', ok: true }) },
    resolveUpstreamUrl: () => 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
    providerTransformerNames: ['antigravity'], modelTransformerNames: [],
  } as SubscriptionDispatchProfile;
  const route = { authMode: 'subscription', subscriptionProfile: profile,
    preferredAccountGroup: 'paid', boundAccountFallbackPolicy: 'pool' } as RouteContext;
  const deps = { llmConfig: { getTransformerService: () => ({ getTransformer: () => new AntigravityTransformer() }) } } as unknown as ProviderProxyDeps;
  return { profile, route, deps, applyHeaders };
}

beforeEach(() => resolveProject.mockReset().mockResolvedValue('project-b'));

describe('Antigravity project uses the selected account', () => {
  it('builds Messages plans with fallback auth and pins the project account', async () => {
    const { profile, route, deps, applyHeaders } = fixture();
    const plan = await buildSubscriptionIterationPlan(profile, route, deps, 'gemini-3-pro', false, undefined, 'session');
    expect(applyHeaders.mock.calls[0]?.[1]).toMatchObject({ resolvedModel: 'gemini-3-pro', preferredAccountGroup: 'paid', sessionKey: 'session' });
    expect(resolveProject).toHaveBeenCalledWith('account-b');
    expect(plan).toMatchObject({ preferredAccountId: 'b', boundAccountFallbackPolicy: 'strict', transformerProvider: { geminiProject: 'project-b' } });
  });

  it('propagates Messages project failure instead of sending an empty project', async () => {
    const { profile, route, deps } = fixture();
    resolveProject.mockRejectedValueOnce(new Error('project unavailable'));
    await expect(buildSubscriptionIterationPlan(profile, route, deps, 'gemini-3-pro', false, undefined)).rejects.toThrow('project unavailable');
  });

  it('passes model context when resolving Responses project and pins the account', async () => {
    const { route, deps, applyHeaders } = fixture();
    const resolved = await resolveResponsesRouteProfile(route, deps, 'gemini-3-pro');
    const plan = await buildResponsesCallPlan(route, deps, resolved, 'gemini-3-pro', false, 'session', 'none', {});
    expect(applyHeaders.mock.calls[0]?.[1]).toMatchObject({ resolvedModel: 'gemini-3-pro', preferredAccountGroup: 'paid' });
    expect(plan).toMatchObject({ preferredAccountId: 'b', boundAccountFallbackPolicy: 'strict', transformerProvider: { geminiProject: 'project-b' } });
  });
});
