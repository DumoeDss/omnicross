import type { WebhookEvent } from '@omnicross/contracts/webhook-types';
import {
  __resetWebhookSinkForTests,
  emitWebhookEvent,
} from '@omnicross/core/pipeline/webhookEmit';
import { SubscriptionAccountHealth } from '@omnicross/core/pipeline/SubscriptionAccountHealth';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebhookDispatcher } from '../webhook/WebhookDispatcher';
import {
  applyWebhookConfig,
  deliverWebhookTest,
  resetWebhookRuntimeForTests,
  setWebhookRuntime,
} from '../webhook/webhookRuntime';

/** A fake dispatcher capturing emitted events + a settable config. */
function makeFakeDispatcher() {
  const emitted: WebhookEvent[] = [];
  let testTarget: string | null = null;
  const fake = {
    emit: (e: WebhookEvent) => emitted.push(e),
    setConfig: () => {},
    deliverTest: async (id: string) => {
      testTarget = id;
      return { ok: true, status: 200 };
    },
  } as unknown as WebhookDispatcher;
  return { fake, emitted, getTestTarget: () => testTarget };
}

const enabledCfg = {
  enabled: true,
  destinations: [{ id: 'd1', type: 'custom' as const, url: 'https://x', enabled: true }],
};

afterEach(() => {
  resetWebhookRuntimeForTests();
  __resetWebhookSinkForTests();
});

describe('webhookRuntime — sink + source wiring', () => {
  it('wires the core sink so emitWebhookEvent reaches the dispatcher when enabled', () => {
    const { fake, emitted } = makeFakeDispatcher();
    setWebhookRuntime(fake, new SubscriptionAccountHealth({ now: () => 1 }));
    applyWebhookConfig(enabledCfg);
    emitWebhookEvent({ kind: 'server.error', at: 1, message: 'x' });
    expect(emitted).toEqual([{ kind: 'server.error', at: 1, message: 'x' }]);
  });

  it('subscribes health recovery + anomaly signals to the dispatcher', () => {
    const { fake, emitted } = makeFakeDispatcher();
    const health = new SubscriptionAccountHealth({ now: () => 100 });
    setWebhookRuntime(fake, health);
    applyWebhookConfig(enabledCfg);
    // Anomaly edge (401) → account.anomaly.
    health.recordUpstreamOutcome('claude', 'a1', { status: 401 });
    // Recovery (2xx after unhealthy) → account.recovery.
    health.recordUpstreamOutcome('claude', 'a1', { status: 200 });
    expect(emitted).toEqual([
      { kind: 'account.anomaly', at: 100, providerId: 'claude', accountId: 'a1', state: 'unauthorized' },
      { kind: 'account.recovery', at: 100, providerId: 'claude', accountId: 'a1' },
    ]);
  });

  it('is INERT when disabled — no sink, no source forwarding (zero regression)', () => {
    const { fake, emitted } = makeFakeDispatcher();
    const health = new SubscriptionAccountHealth({ now: () => 1 });
    setWebhookRuntime(fake, health);
    applyWebhookConfig({ enabled: false, destinations: [] });
    emitWebhookEvent({ kind: 'test', at: 1 });
    health.recordUpstreamOutcome('claude', 'a1', { status: 401 });
    expect(emitted).toHaveLength(0);
  });

  it('tears down the sink + subscriptions on a disable after enable', () => {
    const { fake, emitted } = makeFakeDispatcher();
    const health = new SubscriptionAccountHealth({ now: () => 1 });
    setWebhookRuntime(fake, health);
    applyWebhookConfig(enabledCfg);
    applyWebhookConfig({ enabled: false, destinations: [] });
    emitWebhookEvent({ kind: 'test', at: 1 });
    health.recordUpstreamOutcome('claude', 'a1', { status: 401 });
    expect(emitted).toHaveLength(0);
  });

  it('deliverWebhookTest routes to the dispatcher', async () => {
    const { fake, getTestTarget } = makeFakeDispatcher();
    setWebhookRuntime(fake, new SubscriptionAccountHealth({ now: () => 1 }));
    applyWebhookConfig(enabledCfg);
    const result = await deliverWebhookTest('d1');
    expect(result).toEqual({ ok: true, status: 200 });
    expect(getTestTarget()).toBe('d1');
  });
});
