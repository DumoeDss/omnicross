import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingPublisher } from '../BillingPublisher';
import { BillingRetrySweeper } from '../BillingRetrySweeper';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const NOW = new Date(2026, 6, 7, 12, 0, 0).getTime();

const evt = (over: Partial<BillingEvent> = {}): BillingEvent => ({
  id: 'req-1',
  ts: NOW,
  model: 'claude-sonnet-5',
  authMode: 'byo',
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0.001,
  status: 200,
  ...over,
});

const cfg = (over: Partial<BillingConfig> = {}): BillingConfig => ({
  enabled: true,
  endpoint: 'https://sink.example/billing',
  maxRetryAgeMs: 60 * 60_000, // 1h
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-billing-retry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('BillingRetrySweeper', () => {
  it('re-POSTs an UNDELIVERED event within maxRetryAgeMs', async () => {
    const posted: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(init.body as string).id);
      return new Response('ok', { status: 200 });
    });
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => NOW });
    pub.setConfig(cfg());
    // Seed the ledger with an undelivered event (append only, no delivery attempt).
    pub.appendNow(evt({ id: 'undelivered-1', ts: NOW - 10 * 60_000 }));

    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg(), 60_000, () => NOW);
    const attempted = await sweeper.sweep();
    expect(attempted).toBe(1);
    expect(posted).toEqual(['undelivered-1']);
  });

  it('does NOT re-POST an already-DELIVERED event (delivery-marking prevents double-deliver)', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => NOW });
    pub.setConfig(cfg());
    const e = evt({ id: 'delivered-1', ts: NOW - 5 * 60_000 });
    pub.appendNow(e);
    pub.markDelivered(e); // marker written → considered delivered
    fetchImpl.mockClear();

    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg(), 60_000, () => NOW);
    const attempted = await sweeper.sweep();
    expect(attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves a PAST-AGE undelivered event in the ledger and does NOT re-POST or delete it', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => NOW });
    pub.setConfig(cfg({ maxRetryAgeMs: 60 * 60_000 }));
    // 2h old — beyond the 1h retry bound.
    const stale = evt({ id: 'stale-1', ts: NOW - 2 * 60 * 60_000 });
    pub.appendNow(stale);
    const filesBefore = readdirSync(dir).sort();

    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg({ maxRetryAgeMs: 60 * 60_000 }), 60_000, () => NOW);
    const attempted = await sweeper.sweep();
    // Not re-POSTed (past the bound)…
    expect(attempted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    // …and NEVER deleted — a billing ledger is a financial record.
    expect(readdirSync(dir).sort()).toEqual(filesBefore);
    const ledger = readFileSync(join(dir, filesBefore.find((f) => f.startsWith('billing-')) as string), 'utf8');
    expect(ledger).toContain('stale-1');
  });

  it('a failed re-POST leaves the event undelivered for the next sweep (never dropped)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => NOW });
    pub.setConfig(cfg());
    pub.appendNow(evt({ id: 'retry-me', ts: NOW - 60_000 }));

    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg(), 60_000, () => NOW);
    await sweeper.sweep();
    // Still undelivered → a second sweep retries it again.
    fetchImpl.mockClear();
    await sweeper.sweep();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is disabled (no-op) in ledger-only mode (no endpoint)', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => NOW });
    const ledgerOnly = cfg({ endpoint: undefined });
    pub.setConfig(ledgerOnly);
    pub.appendNow(evt({ id: 'x', ts: NOW }));
    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, ledgerOnly, 60_000, () => NOW);
    expect(sweeper.enabled).toBe(false);
    expect(await sweeper.sweep()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
