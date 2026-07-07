/**
 * Unit tests for the per-key async mutex (voucher-redemption #9, MJ1 fix):
 * same-key ops serialize (no interleave), different keys run concurrently, and a
 * failing op does not wedge the queue.
 */
import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '../keyedMutex';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('KeyedMutex', () => {
  it('serializes ops for the same key (no interleave)', async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const op = (label: string) => async (): Promise<void> => {
      log.push(`${label}:start`);
      await tick();
      log.push(`${label}:end`);
    };
    await Promise.all([
      mutex.runExclusive('k', op('a')),
      mutex.runExclusive('k', op('b')),
      mutex.runExclusive('k', op('c')),
    ]);
    // Each op fully completes before the next starts (FIFO).
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('accumulates a shared counter without lost updates under contention', async () => {
    const mutex = new KeyedMutex();
    let shared = 0;
    const inc = async (): Promise<void> => {
      const snapshot = shared;
      await tick(); // a yield that would race a non-serialized counter
      shared = snapshot + 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => mutex.runExclusive('k', inc)));
    expect(shared).toBe(10);
  });

  it('lets different keys run concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.runExclusive('x', async () => {
        order.push('x:start');
        await tick();
        order.push('x:end');
      }),
      mutex.runExclusive('y', async () => {
        order.push('y:start');
        await tick();
        order.push('y:end');
      }),
    ]);
    // Both start before either ends (they did not serialize).
    expect(order.slice(0, 2).sort()).toEqual(['x:start', 'y:start']);
  });

  it('does not wedge the queue when an op throws', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A subsequent op for the same key still runs.
    const result = await mutex.runExclusive('k', async () => 42);
    expect(result).toBe(42);
  });
});
