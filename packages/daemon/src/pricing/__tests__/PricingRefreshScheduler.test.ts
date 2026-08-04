import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger, PricingEngine } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PricingRefreshScheduler } from '../PricingRefreshScheduler';
import { JsonPricingStore } from '../../ports/JsonPricingStore';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let dir: string;
let statePath: string;
let pricingPath: string;
let catalog: JsonPricingStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omnicross-pricing-refresh-'));
  statePath = join(dir, 'pricing-refresh.json');
  pricingPath = join(dir, 'pricing.json');
  catalog = new JsonPricingStore(pricingPath);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PricingRefreshScheduler', () => {
  it('returns immediately from start while the first remote refresh is pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fetchLatestFromSource = vi.fn(async () => {
      await pending;
      return {
        applied: [], conflicts: [], fetchedAt: 1, sourceUrl: 'primary',
        sources: [],
      };
    });
    const scheduler = new PricingRefreshScheduler(
      { fetchLatestFromSource } as unknown as PricingEngine,
      catalog,
      statePath,
      logger,
      { intervalMs: 60_000 },
    );

    scheduler.start();
    expect(fetchLatestFromSource).toHaveBeenCalledTimes(1);
    expect(existsSync(statePath)).toBe(false);
    release();
    await vi.waitFor(() => expect(existsSync(statePath)).toBe(true));
    scheduler.dispose();
  });

  it('persists success metadata and skips a still-fresh catalog after restart', async () => {
    const fetchLatestFromSource = vi.fn(async () => ({
      applied: [], conflicts: [], fetchedAt: 10, sourceUrl: 'primary',
      sources: [{
        source: 'litellm' as const,
        sourceUrl: 'primary',
        status: 'applied' as const,
        parsedCount: 1,
        appliedCount: 1,
      }],
    }));
    const engine = { fetchLatestFromSource } as unknown as PricingEngine;
    const first = new PricingRefreshScheduler(engine, catalog, statePath, logger, { now: () => 1000 });
    await first.refreshIfStale();
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      lastAttemptAt: 1000,
      lastSuccessAt: 1000,
      lastError: null,
    });
    writeFileSync(pricingPath, JSON.stringify([{
      providerId: 'anthropic',
      modelId: 'claude-test',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    }]), 'utf8');

    const restarted = new PricingRefreshScheduler(engine, catalog, statePath, logger, {
      now: () => 1500,
      staleAfterMs: 1000,
    });
    await restarted.refreshIfStale();
    expect(fetchLatestFromSource).toHaveBeenCalledTimes(1);
  });

  it('retains the previous successful cache timestamp when an offline refresh fails', async () => {
    const ok = vi.fn(async () => ({
      applied: [], conflicts: [], fetchedAt: 1, sourceUrl: 'primary', sources: [],
    }));
    await new PricingRefreshScheduler(
      { fetchLatestFromSource: ok } as unknown as PricingEngine,
      catalog,
      statePath,
      logger,
      { now: () => 1000 },
    ).refreshIfStale();

    const failing = vi.fn(async () => { throw new Error('offline'); });
    await new PricingRefreshScheduler(
      { fetchLatestFromSource: failing } as unknown as PricingEngine,
      catalog,
      statePath,
      logger,
      { now: () => 3000, staleAfterMs: 1000 },
    ).refreshIfStale();

    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      lastAttemptAt: 3000,
      lastSuccessAt: 1000,
      lastError: 'offline',
    });
  });

  it('keeps a partial refresh stale so the failed source is retried', async () => {
    const fetchLatestFromSource = vi.fn(async () => ({
      applied: [], conflicts: [], fetchedAt: 1, sourceUrl: 'primary',
      sources: [
        { source: 'litellm' as const, sourceUrl: 'primary', status: 'applied' as const, parsedCount: 1, appliedCount: 1 },
        { source: 'openrouter' as const, sourceUrl: 'supplement', status: 'failed' as const, parsedCount: 0, appliedCount: 0, error: 'timeout' },
      ],
    }));
    const scheduler = new PricingRefreshScheduler(
      { fetchLatestFromSource } as unknown as PricingEngine,
      catalog,
      statePath,
      logger,
      { now: () => 1000 },
    );

    await scheduler.refreshIfStale();
    await scheduler.refreshIfStale();

    expect(fetchLatestFromSource).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      lastSuccessAt: null,
      lastError: 'openrouter: timeout',
    });
  });

  it.each([
    ['missing', null],
    ['corrupt', '{not-json'],
    ['empty', '[]'],
  ])('refreshes a %s pricing snapshot even when lastSuccessAt is recent', async (_name, contents) => {
    writeFileSync(statePath, JSON.stringify({
      lastAttemptAt: 1000,
      lastSuccessAt: 1000,
      lastError: null,
      sources: [],
    }), 'utf8');
    if (contents !== null) writeFileSync(pricingPath, contents, 'utf8');
    const fetchLatestFromSource = vi.fn(async () => ({
      applied: [], conflicts: [], fetchedAt: 1500, sourceUrl: 'primary', sources: [],
    }));
    const scheduler = new PricingRefreshScheduler(
      { fetchLatestFromSource } as unknown as PricingEngine,
      catalog,
      statePath,
      logger,
      { now: () => 1500, staleAfterMs: 1000 },
    );

    await scheduler.refreshIfStale();

    expect(fetchLatestFromSource).toHaveBeenCalledTimes(1);
  });
});
