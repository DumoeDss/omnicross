import { describe, expect, it, afterEach } from 'vitest';

import type { WebhookEvent } from '@omnicross/contracts/webhook-types';

import {
  __resetWebhookSinkForTests,
  emitWebhookEvent,
  setWebhookSink,
} from '../webhookEmit';

afterEach(() => __resetWebhookSinkForTests());

describe('webhookEmit — module-slot emit port', () => {
  it('is a no-op when no sink is registered (zero regression)', () => {
    // No sink installed → emit must silently do nothing and not throw.
    expect(() => emitWebhookEvent({ kind: 'test', at: 1 })).not.toThrow();
  });

  it('hands the event to a registered sink', () => {
    const seen: WebhookEvent[] = [];
    setWebhookSink((e) => seen.push(e));
    emitWebhookEvent({ kind: 'server.error', at: 5, message: 'boom' });
    expect(seen).toEqual([{ kind: 'server.error', at: 5, message: 'boom' }]);
  });

  it('NEVER throws even when the sink throws (a source is never disrupted)', () => {
    setWebhookSink(() => {
      throw new Error('sink exploded');
    });
    expect(() => emitWebhookEvent({ kind: 'test', at: 1 })).not.toThrow();
  });

  it('emit is synchronous — it returns before an async sink resolves', () => {
    let resolved = false;
    setWebhookSink(() => {
      // A sink that schedules async work must not block the emit caller.
      void Promise.resolve().then(() => {
        resolved = true;
      });
    });
    emitWebhookEvent({ kind: 'test', at: 1 });
    // The microtask hasn't run yet → emit returned immediately.
    expect(resolved).toBe(false);
  });

  it('clearing the sink with null restores the no-op behavior', () => {
    const seen: WebhookEvent[] = [];
    setWebhookSink((e) => seen.push(e));
    setWebhookSink(null);
    emitWebhookEvent({ kind: 'test', at: 1 });
    expect(seen).toHaveLength(0);
  });
});
