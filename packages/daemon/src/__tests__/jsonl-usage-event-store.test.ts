/**
 * jsonl-usage-event-store.test.ts — `JsonlUsageEventStore` JSONL semantics:
 * one-line append per insert, torn-line tolerance, endTs-exclusive ranges,
 * by-model grouping + injected unpriced lookup, by-api-key grouping with the
 * null (unattributed) group, session message rows + cache stats (0-guard).
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UsageEventInput } from '@omnicross/contracts/usage-stats-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlUsageEventStore } from '../ports/JsonlUsageEventStore';

let tmpDir: string;
let eventsPath: string;
let store: JsonlUsageEventStore;
/** Models the injected lookup treats as priced. */
let pricedModels: Set<string>;

const event = (over: Partial<UsageEventInput> = {}): UsageEventInput => ({
  messageId: null,
  parentMessageId: null,
  sessionId: null,
  providerId: 'prov-a',
  model: 'model-x',
  apiKeyId: null,
  engineOrigin: 'completion',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheCreationTokens: 2,
  reasoningTokens: 1,
  costUsd: 0.5,
  costSavedByCacheUsd: 0.1,
  rawUsage: null,
  ...over,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-usage-store-'));
  eventsPath = join(tmpDir, 'usage-events.jsonl');
  pricedModels = new Set(['model-x']);
  store = new JsonlUsageEventStore(eventsPath, async (_p, model) => pricedModels.has(model));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonlUsageEventStore', () => {
  it('insert appends exactly one JSON line per event with distinct ids', async () => {
    const id1 = await store.insert(event({ ts: 100 }));
    const id2 = await store.insert(event({ ts: 200 }));
    expect(id1).not.toBe(id2);
    const lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as { id: string }).id).toBe(id1);
    expect((JSON.parse(lines[1]) as { ts: number }).ts).toBe(200);
  });

  it('stamps ts when absent', async () => {
    const before = Date.now();
    await store.insert(event());
    const row = JSON.parse(readFileSync(eventsPath, 'utf8').trim()) as { ts: number };
    expect(row.ts).toBeGreaterThanOrEqual(before);
  });

  it('queries on a missing file return empty aggregates', async () => {
    const totals = await store.getTotals({ startTs: 0, endTs: Date.now() });
    expect(totals.eventCount).toBe(0);
    expect(totals.costUsd).toBe(0);
  });

  it('tolerates a torn/malformed final line', async () => {
    await store.insert(event({ ts: 100 }));
    appendFileSync(eventsPath, '{"id":"torn","ts":1', 'utf8'); // torn write, no newline
    const totals = await store.getTotals({ startTs: 0, endTs: 1000 });
    expect(totals.eventCount).toBe(1);
    expect(totals.inputTokens).toBe(10);
  });

  it('skips parseable-but-PARTIAL lines (aggregations stay finite)', async () => {
    await store.insert(event({ ts: 100 }));
    // Valid JSON, but missing token/cost fields — without a full row guard
    // these would poison sums with NaN/undefined arithmetic.
    appendFileSync(
      eventsPath,
      JSON.stringify({ id: 'partial', ts: 101, providerId: 'prov-a', model: 'model-x' }) + '\n',
      'utf8',
    );
    // Valid JSON, full shape, but a NON-NUMERIC cost field.
    const goodRow = JSON.parse(readFileSync(eventsPath, 'utf8').split('\n')[0]) as Record<string, unknown>;
    appendFileSync(
      eventsPath,
      JSON.stringify({ ...goodRow, id: 'bad-cost', ts: 102, costUsd: 'not-a-number' }) + '\n',
      'utf8',
    );
    const totals = await store.getTotals({ startTs: 0, endTs: 1000 });
    expect(totals.eventCount).toBe(1); // only the genuine row counted
    expect(Number.isFinite(totals.costUsd)).toBe(true);
    expect(totals.costUsd).toBeCloseTo(0.5);
    const byModel = await store.getByModel({ startTs: 0, endTs: 1000 });
    expect(byModel.every((r) => Number.isFinite(r.costUsd) && Number.isFinite(r.inputTokens))).toBe(true);
  });

  it('getTotals sums all five token fields + costs over an endTs-EXCLUSIVE range', async () => {
    await store.insert(event({ ts: 100 }));
    await store.insert(event({ ts: 199 }));
    await store.insert(event({ ts: 200 })); // ts === endTs → excluded
    await store.insert(event({ ts: 99 })); // before startTs → excluded
    const totals = await store.getTotals({ startTs: 100, endTs: 200 });
    expect(totals.eventCount).toBe(2);
    expect(totals.inputTokens).toBe(20);
    expect(totals.outputTokens).toBe(40);
    expect(totals.cacheReadTokens).toBe(10);
    expect(totals.cacheCreationTokens).toBe(4);
    expect(totals.reasoningTokens).toBe(2);
    expect(totals.costUsd).toBeCloseTo(1.0);
    expect(totals.costSavedByCacheUsd).toBeCloseTo(0.2);
  });

  it('getByModel groups by (providerId, model) and flags unpriced via the injected lookup', async () => {
    await store.insert(event({ ts: 10 }));
    await store.insert(event({ ts: 11 }));
    await store.insert(event({ ts: 12, model: 'mystery-model', costUsd: 0 }));
    const rows = await store.getByModel({ startTs: 0, endTs: 100 });
    expect(rows).toHaveLength(2);
    const known = rows.find((r) => r.model === 'model-x')!;
    const mystery = rows.find((r) => r.model === 'mystery-model')!;
    expect(known.eventCount).toBe(2);
    expect(known.unpriced).toBe(false);
    expect(known.costUsd).toBeCloseTo(1.0);
    expect(mystery.unpriced).toBe(true);
  });

  it('getByApiKey groups by raw apiKeyId with a null unattributed group', async () => {
    await store.insert(event({ ts: 10, apiKeyId: 'k1' }));
    await store.insert(event({ ts: 11, apiKeyId: 'k1' }));
    await store.insert(event({ ts: 12, apiKeyId: null }));
    await store.insert(event({ ts: 13, apiKeyId: null }));
    const rows = await store.getByApiKey({ startTs: 0, endTs: 100 });
    expect(rows).toHaveLength(2);
    const k1 = rows.find((r) => r.apiKeyId === 'k1')!;
    const nul = rows.find((r) => r.apiKeyId === null)!;
    expect(k1.eventCount).toBe(2);
    expect(k1.providerId).toBe('prov-a');
    expect(nul.eventCount).toBe(2);
    expect(nul.providerId).toBeNull();
    expect(nul.label).toBe('unattributed');
  });

  it('getMessagesForSession returns the session rows sorted by ts', async () => {
    await store.insert(event({ ts: 30, sessionId: 's1', messageId: 'm-late' }));
    await store.insert(event({ ts: 10, sessionId: 's1', messageId: 'm-early' }));
    await store.insert(event({ ts: 20, sessionId: 'other' }));
    const rows = await store.getMessagesForSession('s1');
    expect(rows.map((r) => r.messageId)).toEqual(['m-early', 'm-late']);
  });

  it('getSessionCacheStats computes hitRate over prompt-side tokens', async () => {
    await store.insert(event({ ts: 1, sessionId: 's1', inputTokens: 10, cacheReadTokens: 30, cacheCreationTokens: 0 }));
    await store.insert(event({ ts: 2, sessionId: 's1', inputTokens: 10, cacheReadTokens: 30, cacheCreationTokens: 20 }));
    const stats = await store.getSessionCacheStats('s1');
    expect(stats.eventCount).toBe(2);
    // ΣcacheRead 60 / Σ(input 20 + cacheRead 60 + cacheCreation 20) = 0.6
    expect(stats.hitRate).toBeCloseTo(0.6);
  });

  it('getSessionCacheStats guards divide-by-zero (hitRate 0)', async () => {
    await store.insert(event({ ts: 1, sessionId: 's-empty', inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }));
    const stats = await store.getSessionCacheStats('s-empty');
    expect(stats.hitRate).toBe(0);
    const none = await store.getSessionCacheStats('never-seen');
    expect(none.hitRate).toBe(0);
    expect(none.eventCount).toBe(0);
  });
});
