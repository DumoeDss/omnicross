import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BillingConfig, BillingEvent } from '@omnicross/contracts/billing-types';
import type { Logger } from '@omnicross/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { billingFileName, deliveredFileName } from '../billingFiles';
import { BillingPublisher } from '../BillingPublisher';

const noopLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const evt = (over: Partial<BillingEvent> = {}): BillingEvent => ({
  id: 'req-1',
  ts: new Date(2026, 6, 7, 12, 0, 0).getTime(), // local 2026-07-07
  keyId: 'key-abc',
  model: 'claude-sonnet-5',
  provider: 'anthropic',
  authMode: 'byo',
  inputTokens: 100,
  outputTokens: 50,
  costUsd: 0.0123,
  status: 200,
  ...over,
});

const cfg = (over: Partial<BillingConfig> = {}): BillingConfig => ({
  enabled: true,
  maxRetryAgeMs: 24 * 60 * 60_000,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omni-billing-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('BillingPublisher — durable-first', () => {
  it('appends the event to the ledger BEFORE any POST (durable source of truth)', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async () => {
      order.push('post');
      return new Response('ok', { status: 200 });
    });
    // Run the deferred POST synchronously so we can observe ordering.
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, defer: (fn) => fn() });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing' }));
    const e = evt();
    // The ledger line must exist the moment record() returns — before the POST.
    const ledger = join(dir, billingFileName(e.ts));
    const originalAppend = pub.appendNow.bind(pub);
    vi.spyOn(pub, 'appendNow').mockImplementation((event) => {
      order.push('append');
      originalAppend(event);
    });
    pub.record(e);
    // Append happened synchronously in record(), before the POST.
    expect(existsSync(ledger)).toBe(true);
    expect(order[0]).toBe('append');
    // Give the async POST a tick to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['append', 'post']);
  });

  it('a FAILING POST does not lose the event — it stays in the ledger undelivered', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing' }));
    const e = evt();
    pub.appendNow(e);
    const delivered = await pub.deliverNow(e);
    expect(delivered).toBe(false);
    // Event still on disk; NO delivery marker written.
    const ledgerLines = readFileSync(join(dir, billingFileName(e.ts)), 'utf8').trim().split('\n');
    expect(ledgerLines).toHaveLength(1);
    expect(JSON.parse(ledgerLines[0]).id).toBe('req-1');
    expect(existsSync(join(dir, deliveredFileName(e.ts)))).toBe(false);
  });

  it('a THROWING POST does not lose the event and never rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing' }));
    const e = evt();
    pub.appendNow(e);
    await expect(pub.deliverNow(e)).resolves.toBe(false);
    expect(existsSync(join(dir, billingFileName(e.ts)))).toBe(true);
  });

  it('record() returns before the POST resolves (non-blocking)', async () => {
    let resolvePost: (() => void) | null = null;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePost = () => resolve(new Response('ok', { status: 200 }));
        }),
    );
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing' }));
    const e = evt();
    pub.record(e); // returns immediately even though the POST is pending
    expect(existsSync(join(dir, billingFileName(e.ts)))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // Marker NOT yet written — the POST is still pending.
    expect(existsSync(join(dir, deliveredFileName(e.ts)))).toBe(false);
    resolvePost?.();
  });

  it('ledger-only mode (no endpoint) just appends — no POST attempted', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, defer: (fn) => fn() });
    pub.setConfig(cfg({ endpoint: undefined }));
    const e = evt();
    pub.record(e);
    expect(existsSync(join(dir, billingFileName(e.ts)))).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('BillingPublisher — HMAC + delivery marking', () => {
  it('POSTs the event JSON with an HMAC signature when a secret is set', async () => {
    let capturedBody = '';
    let capturedSig = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      capturedSig = (init.headers as Record<string, string>)['X-Omnicross-Billing-Signature'];
      return new Response('ok', { status: 200 });
    });
    const secret = 'super-secret-hmac-key';
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing', secret }));
    const e = evt();
    pub.appendNow(e);
    const ok = await pub.deliverNow(e);
    expect(ok).toBe(true);
    const expected = 'sha256=' + createHmac('sha256', secret).update(capturedBody).digest('hex');
    expect(capturedSig).toBe(expected);
    // The signature verifies over the exact posted body.
    expect(JSON.parse(capturedBody).id).toBe('req-1');
  });

  it('marks an event delivered on a 2xx ack (a marker line is appended)', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 202 }));
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl, now: () => 999 });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing' }));
    const e = evt();
    pub.appendNow(e);
    await pub.deliverNow(e);
    const markerLines = readFileSync(join(dir, deliveredFileName(e.ts)), 'utf8').trim().split('\n');
    expect(markerLines).toHaveLength(1);
    expect(JSON.parse(markerLines[0])).toEqual({ id: 'req-1', deliveredAt: 999 });
  });
});

describe('BillingPublisher — secret-free payload', () => {
  it('the POSTed body carries NO key material / token / signing secret', async () => {
    let body = '';
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return new Response('ok', { status: 200 });
    });
    const secret = 'signing-secret-value';
    const pub = new BillingPublisher(dir, noopLogger, { fetchImpl });
    pub.setConfig(cfg({ endpoint: 'https://sink.example/billing', secret }));
    const e = evt({ keyId: 'key-id-only' });
    pub.appendNow(e);
    await pub.deliverNow(e);
    expect(body).not.toContain(secret);
    expect(body.toLowerCase()).not.toContain('bearer');
    expect(body.toLowerCase()).not.toContain('authorization');
    // The key ID (an attribution id, not material) IS present — by design.
    expect(JSON.parse(body).keyId).toBe('key-id-only');
    // The written ledger line is likewise secret-free.
    const ledger = readFileSync(join(dir, billingFileName(e.ts)), 'utf8');
    expect(ledger).not.toContain(secret);
  });
});
