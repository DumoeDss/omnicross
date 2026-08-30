import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OutboundConcurrencyGate,
  type ImagesServerConfig,
} from '@omnicross/core/outbound-api';

import {
  DaemonImageExecutionScheduler,
  type DaemonImageExecutionSchedulerOptions,
} from '../ImageExecutionScheduler';

function queueConfig(
  overrides: Partial<ImagesServerConfig['queue']> = {},
): ImagesServerConfig['queue'] {
  return {
    maxConcurrentJobsPerAccount: 1,
    maxQueuedJobs: 8,
    queueTimeoutMs: 120_000,
    generationTimeoutMs: 180_000,
    ...overrides,
  };
}

function scheduler(
  config: ImagesServerConfig['queue'] = queueConfig(),
  hmacByte = 7,
): DaemonImageExecutionScheduler {
  const options: DaemonImageExecutionSchedulerOptions = {
    config,
    hmacKey: Buffer.alloc(32, hmacByte),
  };
  return new DaemonImageExecutionScheduler(options);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DaemonImageExecutionScheduler', () => {
  it('limits active work per selected account while different accounts run independently', async () => {
    const gate = scheduler();
    const accountA = gate.deriveAccountKey('RAW_ACCOUNT_A');
    const accountB = gate.deriveAccountKey('RAW_ACCOUNT_B');
    const firstA = await gate.acquire({ tenantId: 'tenant-a', accountKey: accountA, signal: signal() });
    const waitingA = gate.acquire({ tenantId: 'tenant-b', accountKey: accountA, signal: signal() });
    let secondAStarted = false;
    void waitingA.then(() => { secondAStarted = true; });
    await Promise.resolve();
    expect(secondAStarted).toBe(false);

    const firstB = await gate.acquire({ tenantId: 'tenant-a', accountKey: accountB, signal: signal() });
    expect(gate.status()).toMatchObject({
      activeJobs: 2,
      waitingJobs: 1,
      activeAccounts: 2,
      waitingAccounts: 1,
    });

    await firstA.release();
    const secondA = await waitingA;
    expect(secondAStarted).toBe(true);
    await secondA.release();
    await firstB.release();
    expect(gate.status()).toMatchObject({ activeJobs: 0, waitingJobs: 0 });
  });

  it('enforces one bounded global waiting population without displacing waiters', async () => {
    const gate = scheduler(queueConfig({ maxQueuedJobs: 2 }));
    const accountA = gate.deriveAccountKey('account-a');
    const accountB = gate.deriveAccountKey('account-b');
    const activeA = await gate.acquire({ tenantId: 'tenant-a', accountKey: accountA, signal: signal() });
    const activeB = await gate.acquire({ tenantId: 'tenant-b', accountKey: accountB, signal: signal() });
    const firstWaiting = gate.acquire({ tenantId: 'tenant-a', accountKey: accountA, signal: signal() });
    const secondWaiting = gate.acquire({ tenantId: 'tenant-c', accountKey: accountA, signal: signal() });

    await expect(gate.acquire({
      tenantId: 'tenant-d',
      accountKey: accountB,
      signal: signal(),
    })).rejects.toMatchObject({ code: 'image_queue_full', retrySafety: 'before_acceptance' });
    expect(gate.status().waitingJobs).toBe(2);

    await activeA.release();
    const firstGrant = await firstWaiting;
    await firstGrant.release();
    const secondGrant = await secondWaiting;
    await secondGrant.release();
    await activeB.release();
    expect(gate.status()).toMatchObject({ activeJobs: 0, waitingJobs: 0 });
  });

  it('round-robins tenant queues for one saturated account', async () => {
    const gate = scheduler();
    const accountKey = gate.deriveAccountKey('shared-account');
    const active = await gate.acquire({ tenantId: 'tenant-active', accountKey, signal: signal() });
    const order: string[] = [];
    const a1Promise = gate.acquire({ tenantId: 'tenant-a', accountKey, signal: signal() })
      .then((grant) => { order.push('a1'); return grant; });
    const a2Promise = gate.acquire({ tenantId: 'tenant-a', accountKey, signal: signal() })
      .then((grant) => { order.push('a2'); return grant; });
    const b1Promise = gate.acquire({ tenantId: 'tenant-b', accountKey, signal: signal() })
      .then((grant) => { order.push('b1'); return grant; });
    const b2Promise = gate.acquire({ tenantId: 'tenant-b', accountKey, signal: signal() })
      .then((grant) => { order.push('b2'); return grant; });

    await active.release();
    const a1 = await a1Promise;
    expect(order).toEqual(['a1']);
    await a1.release();
    const b1 = await b1Promise;
    expect(order).toEqual(['a1', 'b1']);
    await b1.release();
    const a2 = await a2Promise;
    expect(order).toEqual(['a1', 'b1', 'a2']);
    await a2.release();
    const b2 = await b2Promise;
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2']);
    await b2.release();
  });

  it('uses domain-separated opaque keys, snapshots limits, and exposes aggregate-only status', async () => {
    const mutableConfig = queueConfig({ maxConcurrentJobsPerAccount: 1 });
    const gate = scheduler(mutableConfig);
    mutableConfig.maxConcurrentJobsPerAccount = 8;
    mutableConfig.maxQueuedJobs = 99;

    const rawAccount = 'RAW_ACCOUNT_SECRET_SENTINEL';
    const rawTenant = 'RAW_TENANT_SECRET_SENTINEL';
    const accountKey = gate.deriveAccountKey(rawAccount);
    const otherKey = gate.deriveAccountKey('other-account');
    const otherSaltKey = scheduler(queueConfig(), 9).deriveAccountKey(rawAccount);
    expect(accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(accountKey).not.toContain(rawAccount);
    expect(accountKey).not.toBe(otherKey);
    expect(accountKey).not.toBe(otherSaltKey);

    const active = await gate.acquire({ tenantId: rawTenant, accountKey, signal: signal() });
    const controller = new AbortController();
    const waiting = gate.acquire({ tenantId: rawTenant, accountKey, signal: controller.signal });
    await Promise.resolve();
    const status = gate.status();
    expect(status).toEqual({
      activeJobs: 1,
      waitingJobs: 1,
      activeAccounts: 1,
      waitingAccounts: 1,
      waitingTenants: 1,
      maxConcurrentJobsPerAccount: 1,
      maxQueuedJobs: 8,
      accepting: true,
      shuttingDown: false,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(rawAccount);
    expect(serialized).not.toContain(rawTenant);
    expect(serialized).not.toContain(accountKey);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'request_cancelled' });
    await active.release();
  });

  it('starts the queue deadline at admission and removes an expired waiter', async () => {
    vi.useFakeTimers();
    const gate = scheduler(queueConfig({ queueTimeoutMs: 50 }));
    const accountKey = gate.deriveAccountKey('timed-account');
    const active = await gate.acquire({ tenantId: 'tenant-a', accountKey, signal: signal() });
    const waiting = gate.acquire({ tenantId: 'tenant-b', accountKey, signal: signal() });
    const timeoutResult = expect(waiting).rejects.toMatchObject({
      code: 'image_queue_timeout',
      retrySafety: 'before_acceptance',
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(gate.status().waitingJobs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await timeoutResult;
    expect(gate.status()).toMatchObject({ activeJobs: 1, waitingJobs: 0 });
    await active.release();
  });

  it('retires without disrupting pinned queued work and rejects later admissions', async () => {
    const gate = scheduler();
    const accountKey = gate.deriveAccountKey('retiring-account');
    const active = await gate.acquire({ tenantId: 'tenant-a', accountKey, signal: signal() });
    const waiting = gate.acquire({ tenantId: 'tenant-b', accountKey, signal: signal() });
    gate.retire();
    gate.retire();

    await expect(gate.acquire({
      tenantId: 'tenant-c',
      accountKey,
      signal: signal(),
    })).rejects.toMatchObject({ code: 'request_cancelled' });
    await active.release();
    const pinnedGrant = await waiting;
    expect(gate.status()).toMatchObject({
      accepting: false,
      shuttingDown: false,
      activeJobs: 1,
      waitingJobs: 0,
    });
    await pinnedGrant.release();
    await pinnedGrant.release();
    expect(gate.status()).toMatchObject({ activeJobs: 0, waitingJobs: 0 });
  });

  it('shutdown rejects waiters, cancels active grants, and remains idempotent', async () => {
    const gate = scheduler();
    const accountKey = gate.deriveAccountKey('shutdown-account');
    const active = await gate.acquire({ tenantId: 'tenant-a', accountKey, signal: signal() });
    const waiting = gate.acquire({ tenantId: 'tenant-b', accountKey, signal: signal() });
    const waitingResult = expect(waiting).rejects.toMatchObject({ code: 'request_cancelled' });
    let aborts = 0;
    active.signal?.addEventListener('abort', () => { aborts += 1; });

    gate.shutdown();
    gate.shutdown();
    await waitingResult;
    expect(active.signal?.aborted).toBe(true);
    expect(aborts).toBe(1);
    expect(gate.status()).toMatchObject({
      accepting: false,
      shuttingDown: true,
      activeJobs: 1,
      waitingJobs: 0,
    });
    await active.release();
    await active.release();
    expect(gate.status()).toMatchObject({ activeJobs: 0, waitingJobs: 0 });
  });

  it('does not consume or depend on the generic text concurrency gate', async () => {
    const textGate = new OutboundConcurrencyGate();
    const text = textGate.acquire('shared-tenant', 1, {
      maxQueueSizeFactor: 1,
      minQueueSize: 1,
      waitTimeoutMs: 1_000,
    });
    const textSlot = await text.granted;
    const imageGate = scheduler();
    const accountKey = imageGate.deriveAccountKey('image-account');
    const imageGrant = await imageGate.acquire({
      tenantId: 'shared-tenant',
      accountKey,
      signal: signal(),
    });

    expect(textGate.getStatus()).toEqual([
      { apiKeyId: 'shared-tenant', active: 1, waiting: 0 },
    ]);
    expect(imageGate.status()).toMatchObject({ activeJobs: 1, waitingJobs: 0 });
    await imageGrant.release();
    textSlot.release();
  });
});
