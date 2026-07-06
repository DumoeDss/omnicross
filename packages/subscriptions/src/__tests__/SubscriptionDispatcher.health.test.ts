/**
 * SubscriptionDispatcher account-health marking tests (subscription-account-health,
 * review Major + Minor #2). Drives the daemon dispatch loop (the opencodego
 * Anthropic-shape bypass) with a `fetchWithRetry` that throws a `ProviderApiError`
 * carrying the upstream response `headers`/`bodyText` — proving the daemon-path
 * 429-reset cooldown + 403-ban sniff FUNCTION when the host attaches them, and
 * that a post-refresh retry-that-throws is still health-marked.
 */

import type http from 'node:http';

import type { OpenCodeGoTokenConfig } from '@omnicross/contracts/subscription-types';
import {
  __resetSharedAccountHealthForTests,
  getSharedAccountHealth,
} from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DispatcherHooks,
  type DispatchRequest,
  SubscriptionDispatcher,
} from '../SubscriptionDispatcher';
import type { SubscriptionDispatchProfile } from '../SubscriptionProviderRegistry';

/** A `ProviderApiError`-shaped error carrying `.status` plus the OPTIONAL upstream
 *  `headers`/`bodyText` the account-health contract reads structurally. */
class FakeProviderApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly headers?: Record<string, string>,
    public readonly bodyText?: string,
  ) {
    super('upstream error');
    this.name = 'ProviderApiError';
  }
}

/** opencodego bypass profile (MiniMax anthropic-shape → verbatim /v1/messages).
 *  Its `applyHeaders` reports a fixed account id so the dispatcher marks it. */
function makeProfile(onUnauthorized = vi.fn(async () => false)): SubscriptionDispatchProfile {
  return {
    providerId: 'opencodego',
    displayName: 'OpenCodeGo',
    authStrategy: {
      kind: 'static-bearer',
      providerId: 'opencodego',
      applyHeaders: vi.fn(async (headers: Record<string, string>, hints?: { reportSelection?: (id: string, active: boolean) => void }) => {
        headers['Authorization'] = 'Bearer fake';
        hints?.reportSelection?.('acct-1', false);
      }),
      onUnauthorized,
      describeStatus: vi.fn(async () => ({ providerId: 'opencodego', ok: true })),
    } as unknown as SubscriptionDispatchProfile['authStrategy'],
    mode: 'transformer',
    resolveUpstreamUrl: () => 'https://opencode.ai/zen/go/v1/messages',
    providerTransformerNames: ['opencodego'],
    modelMapper: () => ({ resolvedModel: 'minimax-m2.5', scenario: 'long_context' }),
    // No nextFallback ⇒ a single attempt, then the error surfaces.
  } as unknown as SubscriptionDispatchProfile;
}

/** Hooks whose `fetchWithRetry` throws a supplied sequence of errors (one per call). */
function makeHooks(errors: Array<FakeProviderApiError | Error>): DispatcherHooks {
  let call = 0;
  return {
    endpointTransformer: {} as DispatcherHooks['endpointTransformer'],
    executor: {} as DispatcherHooks['executor'],
    transformerService: {} as DispatcherHooks['transformerService'],
    fetchWithRetry: vi.fn(async () => {
      throw errors[Math.min(call++, errors.length - 1)];
    }),
    writeProxyResponse: vi.fn(async () => undefined),
  };
}

function makeReq(): DispatchRequest {
  return {
    reqId: 1,
    res: {} as http.ServerResponse,
    rawBody: JSON.stringify({ model: 'cli', messages: [] }),
    anthropicBody: { model: 'cli', messages: [] },
    isStream: false,
    sdkModel: 'cli',
    fallbackModel: 'minimax-m2.5',
  };
}

const NO_CONFIG = async (): Promise<OpenCodeGoTokenConfig | undefined> => undefined;

beforeEach(() => __resetSharedAccountHealthForTests());

describe('SubscriptionDispatcher — daemon-path health marking (review Major)', () => {
  it('a 429 with a retry-after header cools the account (non-claude driver)', async () => {
    const err = new FakeProviderApiError(429, { 'retry-after': '120' });
    const dispatcher = new SubscriptionDispatcher(makeProfile(), makeHooks([err]), NO_CONFIG);
    await expect(dispatcher.dispatch(makeReq())).rejects.toBe(err);

    const health = getSharedAccountHealth();
    expect(health.isSchedulable('opencodego', 'acct-1')).toBe(false);
    expect(health.getStatus('opencodego', 'acct-1').state).toBe('rate_limited');
  });

  it('a bare 429 with NO headers is not marked (graceful degrade)', async () => {
    const err = new FakeProviderApiError(429); // no headers attached
    const dispatcher = new SubscriptionDispatcher(makeProfile(), makeHooks([err]), NO_CONFIG);
    await expect(dispatcher.dispatch(makeReq())).rejects.toBe(err);
    expect(getSharedAccountHealth().isSchedulable('opencodego', 'acct-1')).toBe(true);
  });

  it('a 403-ban body blocks the account permanently', async () => {
    const err = new FakeProviderApiError(403, {}, 'this organization has been disabled');
    const dispatcher = new SubscriptionDispatcher(makeProfile(), makeHooks([err]), NO_CONFIG);
    await expect(dispatcher.dispatch(makeReq())).rejects.toBe(err);
    expect(getSharedAccountHealth().getStatus('opencodego', 'acct-1').state).toBe('blocked');
  });
});

describe('SubscriptionDispatcher — retry-that-throws is marked (review Minor #2)', () => {
  it('marks the FINAL failure when the post-refresh retry throws again', async () => {
    // First attempt 401 → onUnauthorized true → retry → throws 500 (transient).
    const onUnauthorized = vi.fn(async () => true);
    const first = new FakeProviderApiError(401);
    const retry = new FakeProviderApiError(500);
    const dispatcher = new SubscriptionDispatcher(
      makeProfile(onUnauthorized),
      makeHooks([first, retry]),
      NO_CONFIG,
    );
    await expect(dispatcher.dispatch(makeReq())).rejects.toBe(retry);
    expect(onUnauthorized).toHaveBeenCalled();
    expect(getSharedAccountHealth().getStatus('opencodego', 'acct-1').state).toBe('transient');
  });
});
