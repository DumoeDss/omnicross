import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BillingConfig } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import {
  __resetBillingSinkForTests,
  getBillingCaptureConfig,
  publishBillingEvent,
} from '@omnicross/core/pipeline/billingEmit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingPublisher } from '../BillingPublisher';
import { BillingRetrySweeper } from '../BillingRetrySweeper';
import { applyBillingConfig, resetBillingRuntimeForTests, setBillingRuntime } from '../billingRuntime';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const cfg = (over: Partial<BillingConfig> = {}): BillingConfig => ({
  enabled: true,
  maxRetryAgeMs: 24 * 60 * 60_000,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-billing-rt-'));
});
afterEach(() => {
  resetBillingRuntimeForTests();
  __resetBillingSinkForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('billingRuntime', () => {
  it('enabling installs the core capture gate + sink so publishBillingEvent records', () => {
    const pub = new BillingPublisher(dir, noopLogger, { defer: (fn) => fn() });
    const record = vi.spyOn(pub, 'record');
    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg());
    setBillingRuntime(pub, sweeper);

    applyBillingConfig(cfg({ endpoint: undefined })); // ledger-only, still records
    expect(getBillingCaptureConfig()).not.toBeNull();
    publishBillingEvent({
      id: 'e1',
      ts: Date.now(),
      model: 'm',
      authMode: 'byo',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      status: 200,
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('disabling clears both core slots → publishBillingEvent is a no-op (zero regression)', () => {
    const pub = new BillingPublisher(dir, noopLogger, { defer: (fn) => fn() });
    const record = vi.spyOn(pub, 'record');
    const sweeper = new BillingRetrySweeper(dir, pub, noopLogger, cfg());
    setBillingRuntime(pub, sweeper);

    applyBillingConfig(cfg({ enabled: true }));
    applyBillingConfig(cfg({ enabled: false }));
    expect(getBillingCaptureConfig()).toBeNull();
    publishBillingEvent({
      id: 'e2',
      ts: Date.now(),
      model: 'm',
      authMode: 'byo',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.001,
      status: 200,
    });
    expect(record).not.toHaveBeenCalled();
  });
});
