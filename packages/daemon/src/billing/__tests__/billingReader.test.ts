import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readBillingStatus, readUndeliveredEvents } from '../billingReader';
import { BillingPublisher } from '../BillingPublisher';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const NOW = new Date(2026, 6, 7, 12, 0, 0).getTime();

const evt = (id: string, over: Partial<BillingEvent> = {}): BillingEvent => ({
  id,
  ts: NOW,
  model: 'm',
  authMode: 'byo',
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0.001,
  status: 200,
  ...over,
});

const cfg: BillingConfig = { enabled: true, endpoint: 'https://x', maxRetryAgeMs: 1000 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-billing-read-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('billingReader', () => {
  it('reports total/delivered/pending counts from ledger + markers', () => {
    const pub = new BillingPublisher(dir, noopLogger);
    pub.setConfig(cfg);
    pub.appendNow(evt('a'));
    pub.appendNow(evt('b'));
    pub.appendNow(evt('c'));
    pub.markDelivered(evt('b'));
    const status = readBillingStatus(dir);
    expect(status).toEqual({ total: 3, delivered: 1, pending: 2 });
  });

  it('returns only UNDELIVERED events, oldest first', () => {
    const pub = new BillingPublisher(dir, noopLogger);
    pub.setConfig(cfg);
    pub.appendNow(evt('old', { ts: NOW - 1000 }));
    pub.appendNow(evt('new', { ts: NOW }));
    pub.appendNow(evt('done', { ts: NOW - 500 }));
    pub.markDelivered(evt('done', { ts: NOW - 500 }));
    const undelivered = readUndeliveredEvents(dir).map((e) => e.id);
    expect(undelivered).toEqual(['old', 'new']);
  });

  it('missing dir ⇒ zeroed status (no throw)', () => {
    expect(readBillingStatus(join(dir, 'nope'))).toEqual({ total: 0, delivered: 0, pending: 0 });
    expect(readUndeliveredEvents(join(dir, 'nope'))).toEqual([]);
  });
});
