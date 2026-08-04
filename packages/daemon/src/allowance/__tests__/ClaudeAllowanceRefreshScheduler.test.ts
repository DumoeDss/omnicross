import type { Logger } from '@omnicross/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAllowanceRefreshScheduler } from '../ClaudeAllowanceRefreshScheduler';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function policy(enabled: boolean) {
  return {
    enabled,
    demoteAtPercent: 80,
    pauseAtPercent: 98,
    priorityPenalty: 100,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ClaudeAllowanceRefreshScheduler', () => {
  it('performs zero work by default and after a live disable', async () => {
    vi.useFakeTimers();
    const maintainClaudeCache = vi.fn(async () => undefined);
    const scheduler = new ClaudeAllowanceRefreshScheduler(
      { maintainClaudeCache },
      logger,
      1_000,
      90_000,
    );

    scheduler.configure(policy(false));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(maintainClaudeCache).not.toHaveBeenCalled();

    scheduler.configure(policy(true));
    await vi.waitFor(() => expect(maintainClaudeCache).toHaveBeenCalledTimes(1));
    expect(maintainClaudeCache).toHaveBeenCalledWith(90_000);

    scheduler.configure(policy(false));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(maintainClaudeCache).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('starts non-blocking, coalesces ticks, and can be hot re-enabled', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const maintainClaudeCache = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue(undefined);
    const scheduler = new ClaudeAllowanceRefreshScheduler(
      { maintainClaudeCache },
      logger,
      1_000,
    );

    scheduler.configure(policy(true));
    scheduler.start();
    expect(maintainClaudeCache).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(maintainClaudeCache).toHaveBeenCalledTimes(1);
    resolveFirst();
    await first;
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(maintainClaudeCache).toHaveBeenCalledTimes(2);

    scheduler.configure(policy(false));
    scheduler.configure(policy(true));
    await vi.waitFor(() => expect(maintainClaudeCache).toHaveBeenCalledTimes(3));
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(maintainClaudeCache).toHaveBeenCalledTimes(3);
  });

  it('contains background failures and logs no credential material of its own', async () => {
    const maintainClaudeCache = vi.fn(async () => { throw new Error('upstream unavailable'); });
    const scheduler = new ClaudeAllowanceRefreshScheduler({ maintainClaudeCache }, logger);
    scheduler.configure(policy(true));

    await expect(scheduler.sweep()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude allowance background refresh failed',
      { error: 'upstream unavailable' },
    );
    scheduler.dispose();
  });
});
