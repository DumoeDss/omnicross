import type http from 'node:http';

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';
import { afterEach, describe, expect, it } from 'vitest';

import { __resetBillingSinkForTests, setBillingCaptureConfig, setBillingSink } from '../../pipeline/billingEmit';
import { __clearAuditUsageForTests, stashAuditUsage } from '../../pipeline/auditUsageStash';
import { beginBillingCapture } from '../billingCapture';

const cfg = (over: Partial<BillingConfig> = {}): BillingConfig => ({
  enabled: true,
  maxRetryAgeMs: 24 * 60 * 60_000,
  ...over,
});

function fakeReq(): http.IncomingMessage {
  return { method: 'POST', url: '/v1/messages', headers: {}, socket: {} } as unknown as http.IncomingMessage;
}

class FakeRes {
  statusCode = 200;
  private closeListeners: Array<() => void> = [];
  once(event: string, fn: () => void): this {
    if (event === 'close') this.closeListeners.push(fn);
    return this;
  }
  triggerClose(): void {
    for (const l of this.closeListeners) l();
  }
}

/** Run the deferred assembly synchronously so tests observe the emit at close. */
const syncDefer = (fn: () => void): void => fn();

afterEach(() => __resetBillingSinkForTests());

describe('beginBillingCapture — gating (zero regression)', () => {
  it('returns null when billing is disabled', () => {
    const ctx = beginBillingCapture(fakeReq(), new FakeRes() as unknown as http.ServerResponse, 100, syncDefer);
    expect(ctx).toBeNull();
  });

  it('emits nothing when disabled even on response close', () => {
    const seen: BillingEvent[] = [];
    setBillingSink((e) => seen.push(e));
    const r = new FakeRes();
    beginBillingCapture(fakeReq(), r as unknown as http.ServerResponse, 100, syncDefer);
    r.triggerClose();
    expect(seen).toHaveLength(0);
  });
});

describe('beginBillingCapture — billable-only + cost reuse', () => {
  it('does NOT emit for a request that produced no usage (not billable)', () => {
    setBillingCaptureConfig(cfg());
    const seen: BillingEvent[] = [];
    setBillingSink((e) => seen.push(e));
    const r = new FakeRes();
    const ctx = beginBillingCapture(fakeReq(), r as unknown as http.ServerResponse, 100, syncDefer);
    expect(ctx).not.toBeNull();
    if (ctx) ctx.keyId = 'key-1'; // auth ran but nothing dispatched
    r.triggerClose();
    expect(seen).toHaveLength(0);
  });

  it('emits a metered-fact event reusing the stashed cost (no re-pricing)', () => {
    setBillingCaptureConfig(cfg());
    const seen: BillingEvent[] = [];
    setBillingSink((e) => seen.push(e));
    const r = new FakeRes();
    r.statusCode = 200;
    const ctx = beginBillingCapture(fakeReq(), r as unknown as http.ServerResponse, 4242, syncDefer);
    if (ctx) {
      ctx.keyId = 'key-1';
      ctx.model = 'claude-sonnet-5';
      ctx.provider = 'anthropic';
      ctx.authMode = 'subscription';
    }
    // The usage tap stashed tokens + the already-computed cost keyed by this res.
    stashAuditUsage(r, { inputTokens: 120, outputTokens: 45, costUsd: 0.0321, model: 'x', provider: 'y' });
    r.triggerClose();
    expect(seen).toHaveLength(1);
    const event = seen[0];
    expect(event).toMatchObject({
      ts: 4242,
      keyId: 'key-1',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      authMode: 'subscription',
      inputTokens: 120,
      outputTokens: 45,
      costUsd: 0.0321,
      status: 200,
    });
    expect(typeof event.id).toBe('string');
    __clearAuditUsageForTests(r);
  });

  it('the emitted event carries ONLY the closed secret-free schema', () => {
    setBillingCaptureConfig(cfg());
    let event: BillingEvent | null = null;
    setBillingSink((e) => (event = e));
    const r = new FakeRes();
    const ctx = beginBillingCapture(fakeReq(), r as unknown as http.ServerResponse, 1, syncDefer);
    if (ctx) ctx.keyId = 'key-abc';
    stashAuditUsage(r, { inputTokens: 1, outputTokens: 1, costUsd: 0.001 });
    r.triggerClose();
    const keys = Object.keys(event as unknown as BillingEvent).sort();
    // No token/secret/authorization field can appear — only the frozen schema.
    expect(keys).toEqual(
      ['authMode', 'costUsd', 'id', 'inputTokens', 'keyId', 'model', 'outputTokens', 'status', 'ts'].sort(),
    );
    __clearAuditUsageForTests(r);
  });
});
