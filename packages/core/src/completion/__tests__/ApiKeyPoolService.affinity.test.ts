import type { ApiKeyEntry } from '@omnicross/contracts/llm-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../ports/logger';
import { ApiKeyPoolService } from '../ApiKeyPoolService';

function key(providerId: string, id: string): ApiKeyEntry {
  return {
    id,
    providerId,
    label: `${providerId}/${id}`,
    apiKey: `fixture-${providerId}-${id}`,
    enabled: true,
    weight: 1,
    sortOrder: 0,
  };
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let pool: ApiKeyPoolService;

function createPool(rows: Record<string, ApiKeyEntry[]> = {
  a: [key('a', 'a1'), key('a', 'a2')],
  b: [key('b', 'b1'), key('b', 'b2')],
}) {
  const loadKeys = vi.fn(async (providerId: string) => rows[providerId] ?? []);
  const autoDisable = vi.fn(async (keyId: string) => {
    for (const entries of Object.values(rows)) {
      const entry = entries.find((candidate) => candidate.id === keyId);
      if (entry) entry.enabled = false;
    }
  });
  pool = new ApiKeyPoolService(loadKeys, (raw) => raw, logger, undefined, autoDisable);
  return { rows, loadKeys, autoDisable };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  pool?.dispose();
  vi.useRealTimers();
});

describe('ApiKeyPoolService provider+session affinity', () => {
  it('retains each multi-key provider binding through A -> B -> A without rotating per request', async () => {
    createPool();

    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a1');
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-b1');
    for (let turn = 0; turn < 4; turn += 1) {
      await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a1');
      await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-b1');
    }
    expect(pool.getKeyIdForSession('a', 'conversation')).toBe('a1');
    expect(pool.getKeyIdForSession('b', 'conversation')).toBe('b1');
    expect(pool.getKeyIdForSession('missing', 'conversation')).toBeNull();
    await expect(pool.getKeyForSession('a', 'next-conversation')).resolves.toBe('fixture-a-a2');
    await expect(pool.getKeyForSession('b', 'next-conversation')).resolves.toBe('fixture-b-b2');
  });

  it('keeps concurrent first calls to the same pair on one key while providers load out of order', async () => {
    let resolveA!: (keys: ApiKeyEntry[]) => void;
    let resolveB!: (keys: ApiKeyEntry[]) => void;
    const pendingA = new Promise<ApiKeyEntry[]>((resolve) => { resolveA = resolve; });
    const pendingB = new Promise<ApiKeyEntry[]>((resolve) => { resolveB = resolve; });
    pool = new ApiKeyPoolService(
      (providerId) => providerId === 'a' ? pendingA : pendingB,
      (raw) => raw,
      logger,
    );

    const aFirst = pool.getKeyForSession('a', 'conversation');
    const bFirst = pool.getKeyForSession('b', 'conversation');
    const aSecond = pool.getKeyForSession('a', 'conversation');
    const bSecond = pool.getKeyForSession('b', 'conversation');
    resolveB([key('b', 'b1'), key('b', 'b2')]);
    await expect(bFirst).resolves.toBe('fixture-b-b1');
    resolveA([key('a', 'a1'), key('a', 'a2')]);

    await expect(Promise.all([aFirst, bFirst, aSecond, bSecond])).resolves.toEqual([
      'fixture-a-a1', 'fixture-b-b1', 'fixture-a-a1', 'fixture-b-b1',
    ]);
    await expect(pool.getKeyForSession('a', 'another')).resolves.toBe('fixture-a-a2');
    await expect(pool.getKeyForSession('b', 'another')).resolves.toBe('fixture-b-b2');
  });

  it('uses collision-safe provider/session pairs instead of delimiter-concatenated ids', async () => {
    createPool({
      'a:b': [key('a:b', 'first')],
      a: [key('a', 'second')],
    });

    await expect(pool.getKeyForSession('a:b', 'c')).resolves.toBe('fixture-a:b-first');
    await expect(pool.getKeyForSession('a', 'b:c')).resolves.toBe('fixture-a-second');
    expect(pool.getKeyIdForSession('a:b', 'c')).toBe('first');
    expect(pool.getKeyIdForSession('a', 'b:c')).toBe('second');
    pool.releaseSession('c');
    expect(pool.getKeyIdForSession('a', 'b:c')).toBe('second');
  });

  it.each([429, 529])('rebinds only the reported provider on %i, not the provider most recently used', async (status) => {
    createPool();
    await pool.getKeyForSession('a', 'conversation');
    await pool.getKeyForSession('b', 'conversation');

    await expect(pool.reportError('a', 'conversation', status)).resolves.toBe('fixture-a-a2');
    expect(pool.getKeyIdForSession('a', 'conversation')).toBe('a2');
    expect(pool.getKeyIdForSession('b', 'conversation')).toBe('b1');
    await expect(pool.getKeyHealth('a')).resolves.toEqual({
      a1: { until: Date.now() + 60_000, errors: 1, lastStatus: status },
    });
    await expect(pool.getKeyHealth('b')).resolves.toEqual({});
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-b1');
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a2');
    await expect(pool.reportError('absent', 'conversation', 429)).resolves.toBeNull();
    await expect(pool.reportError('b', 'conversation', 500)).resolves.toBeNull();
    expect(pool.getKeyIdForSession('b', 'conversation')).toBe('b1');
  });

  it('isolates cooldowns and success resets even when provider-local key ids are equal', async () => {
    createPool({ a: [key('a', 'same')], b: [key('b', 'same')] });
    await pool.getKeyForSession('a', 'conversation');
    await pool.getKeyForSession('b', 'conversation');
    await expect(pool.reportError('a', 'conversation', 429)).resolves.toBeNull();
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-same');
    pool.reportSuccess('b', 'conversation');
    await expect(pool.getPoolAvailability('a')).resolves.toEqual({
      outcome: 'exhausted', retryAfterSeconds: 60,
    });

    await pool.reportError('b', 'conversation', 529);
    await pool.reportError('a', 'conversation', 429);
    await expect(pool.getKeyHealth('a')).resolves.toEqual({
      same: { until: Date.now() + 120_000, errors: 2, lastStatus: 429 },
    });
    pool.reportSuccess('a', 'conversation');
    await expect(pool.getKeyHealth('a')).resolves.toEqual({});
    await expect(pool.getKeyHealth('b')).resolves.toEqual({
      same: { until: Date.now() + 60_000, errors: 1, lastStatus: 529 },
    });
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('');
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-same');
    await pool.reportError('a', 'conversation', 429);
    await expect(pool.getKeyHealth('a')).resolves.toEqual({
      same: { until: Date.now() + 60_000, errors: 1, lastStatus: 429 },
    });
  });

  it.each([401, 403])('auto-disables and rebinds the failed provider on %i without disabling the other binding', async (status) => {
    const { autoDisable } = createPool();
    await pool.getKeyForSession('a', 'conversation');
    await pool.getKeyForSession('b', 'conversation');

    await expect(pool.reportError('a', 'conversation', status)).resolves.toBe('fixture-a-a2');
    expect(autoDisable).toHaveBeenCalledWith('a1', status, Date.now());
    await expect(pool.getKeyAvailability('a', 'a1')).resolves.toBe('unavailable');
    await expect(pool.getKeyAvailability('b', 'b1')).resolves.toBe('usable');
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-b1');
  });

  it('preserves explicit bindings, including an empty session id, and rejects unavailable keys without clobbering', async () => {
    const { rows } = createPool();
    rows.a.push({ ...key('a', 'disabled'), enabled: false });
    await expect(pool.getKeyById('a', 'a2', 'conversation')).resolves.toBe('fixture-a-a2');
    await expect(pool.getKeyById('b', 'b2', 'conversation')).resolves.toBe('fixture-b-b2');
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a2');
    await expect(pool.getKeyById('a', 'missing', 'conversation')).resolves.toBe('');
    await expect(pool.getKeyById('a', 'disabled', 'conversation')).resolves.toBe('');
    expect(pool.getKeyIdForSession('a', 'conversation')).toBe('a2');
    await pool.getKeyById('a', 'a1', '');
    expect(pool.getKeyIdForSession('a', '')).toBe('a1');
    await pool.getKeyById('b', 'b1', null);
    expect(pool.getKeyIdForSession('b', '')).toBeNull();
    await pool.reportError('a', 'conversation', 429);
    await expect(pool.getKeyById('a', 'a2', 'conversation')).resolves.toBe('');
    expect(pool.getKeyIdForSession('b', 'conversation')).toBe('b2');
  });

  it('retains healthy affinity across cache invalidation and only rebinds deleted provider keys', async () => {
    const { rows } = createPool();
    await pool.getKeyForSession('a', 'conversation');
    await pool.getKeyForSession('b', 'conversation');
    pool.invalidateCache('a');
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a1');
    rows.a = [key('a', 'a2')];
    pool.invalidateCache('a');
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a2');
    expect(pool.getKeyIdForSession('b', 'conversation')).toBe('b1');
    pool.invalidateCache();
    await expect(pool.getKeyForSession('a', 'conversation')).resolves.toBe('fixture-a-a2');
    await expect(pool.getKeyForSession('b', 'conversation')).resolves.toBe('fixture-b-b1');
  });

  it('releases all provider bindings for one session without affecting another session', async () => {
    createPool();
    await pool.getKeyForSession('a', 'released');
    await pool.getKeyForSession('b', 'released');
    await pool.getKeyForSession('a', 'retained');
    await pool.getKeyForSession('b', 'retained');
    pool.releaseSession('released');
    pool.releaseSession('released');

    expect(pool.getKeyIdForSession('a', 'released')).toBeNull();
    expect(pool.getKeyIdForSession('b', 'released')).toBeNull();
    expect(pool.getKeyIdForSession('a', 'retained')).toBe('a2');
    expect(pool.getKeyIdForSession('b', 'retained')).toBe('b2');
    await expect(pool.reportError('a', 'released', 429)).resolves.toBeNull();
    await expect(pool.getKeyHealth('a')).resolves.toEqual({});
  });

  it('expires cooldowns independently and disposes the timer and all bindings', async () => {
    createPool({ a: [key('a', 'same')], b: [key('b', 'same')] });
    await pool.getKeyForSession('a', 'conversation');
    await pool.getKeyForSession('b', 'conversation');
    await pool.reportError('a', 'conversation', 429);
    await pool.reportError('b', 'conversation', 529);
    await pool.reportError('b', 'conversation', 529);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(60_000);
    await expect(pool.getKeyHealth('a')).resolves.toEqual({});
    await expect(pool.getPoolAvailability('a')).resolves.toEqual({ outcome: 'usable' });
    await expect(pool.getPoolAvailability('b')).resolves.toEqual({
      outcome: 'exhausted', retryAfterSeconds: 60,
    });
    await pool.reportError('a', 'conversation', 429);
    await expect(pool.getKeyHealth('a')).resolves.toEqual({
      same: { until: Date.now() + 60_000, errors: 1, lastStatus: 429 },
    });
    pool.dispose();
    pool.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(pool.getKeyIdForSession('a', 'conversation')).toBeNull();
    expect(pool.getKeyIdForSession('b', 'conversation')).toBeNull();
  });
});
