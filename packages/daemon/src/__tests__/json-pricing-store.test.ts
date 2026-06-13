/**
 * json-pricing-store.test.ts — `JsonPricingStore` file semantics: defensive
 * empty read, upsert provenance stamping, bulk-apply user-edit conflict split
 * (single batch write), resolution counts, store-local delete.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PricingEntryInput } from '@omnicross/contracts/pricing-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonPricingStore } from '../ports/JsonPricingStore';

let tmpDir: string;
let pricingPath: string;
let store: JsonPricingStore;

const input = (providerId: string, modelId: string, over: Partial<PricingEntryInput> = {}): PricingEntryInput => ({
  providerId,
  modelId,
  inputPricePer1m: 3,
  outputPricePer1m: 15,
  cacheReadPricePer1m: 0.3,
  cacheWritePricePer1m: 3.75,
  ...over,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-pricing-store-'));
  pricingPath = join(tmpDir, 'pricing.json');
  store = new JsonPricingStore(pricingPath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('JsonPricingStore', () => {
  it('reads a missing file as an empty table (no file created)', async () => {
    await expect(store.getAll()).resolves.toEqual([]);
    expect(existsSync(pricingPath)).toBe(false);
  });

  it('reads a corrupt file as an empty table', async () => {
    writeFileSync(pricingPath, '{not json[', 'utf8');
    await expect(store.getAll()).resolves.toEqual([]);
  });

  it('upsert(_, true) stamps user provenance; upsert(_, false) stamps litellm', async () => {
    const user = await store.upsert(input('p1', 'm1'), true);
    expect(user.source).toBe('user');
    expect(user.userEdited).toBe(true);
    expect(user.editedAt).not.toBeNull();
    expect(user.updatedAt).toBeGreaterThan(0);

    const auto = await store.upsert(input('p1', 'm2'), false);
    expect(auto.source).toBe('litellm');
    expect(auto.userEdited).toBe(false);
    expect(auto.editedAt).toBeNull();

    // Persisted: a fresh instance reads both rows back.
    const fresh = new JsonPricingStore(pricingPath);
    const all = await fresh.getAll();
    expect(all).toHaveLength(2);
  });

  it('upsert replaces the existing (providerId, modelId) row', async () => {
    await store.upsert(input('p1', 'm1', { inputPricePer1m: 1 }), false);
    await store.upsert(input('p1', 'm1', { inputPricePer1m: 9 }), true);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].inputPricePer1m).toBe(9);
    expect(all[0].userEdited).toBe(true);
  });

  it('bulkApplyFromSource splits user-edited conflicts and applies the rest in ONE write', async () => {
    await store.upsert(input('p1', 'edited', { inputPricePer1m: 99 }), true);
    const writeSpy = vi.spyOn(store as never as { writeRows: (r: unknown) => void }, 'writeRows');

    const { applied, conflicts } = await store.bulkApplyFromSource([
      input('p1', 'edited', { inputPricePer1m: 1 }),
      input('p1', 'new-a'),
      input('p1', 'new-b'),
    ]);

    expect(applied.map((a) => a.modelId).sort()).toEqual(['new-a', 'new-b']);
    expect(applied.every((a) => a.source === 'litellm' && !a.userEdited)).toBe(true);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].current.modelId).toBe('edited');
    expect(conflicts[0].current.inputPricePer1m).toBe(99); // unchanged on disk
    expect(conflicts[0].incoming.inputPricePer1m).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1); // single batch write

    const edited = (await store.getAll()).find((r) => r.modelId === 'edited')!;
    expect(edited.inputPricePer1m).toBe(99);
    expect(edited.userEdited).toBe(true);
  });

  it('applyResolutions overwrites (clearing userEdited) and counts skips', async () => {
    await store.upsert(input('p1', 'a', { inputPricePer1m: 50 }), true);
    await store.upsert(input('p1', 'b', { inputPricePer1m: 60 }), true);

    const result = await store.applyResolutions([
      { incoming: input('p1', 'a', { inputPricePer1m: 2 }), action: 'overwrite' },
      { incoming: input('p1', 'b', { inputPricePer1m: 3 }), action: 'skip' },
    ]);
    expect(result).toEqual({ overwrittenCount: 1, skippedCount: 1 });

    const all = await store.getAll();
    const a = all.find((r) => r.modelId === 'a')!;
    const b = all.find((r) => r.modelId === 'b')!;
    expect(a.inputPricePer1m).toBe(2);
    expect(a.userEdited).toBe(false);
    expect(a.source).toBe('litellm');
    expect(b.inputPricePer1m).toBe(60);
    expect(b.userEdited).toBe(true);
  });

  it('delete removes the row (true) and a second delete returns false', async () => {
    await store.upsert(input('p1', 'm1'), false);
    await expect(store.delete('p1', 'm1')).resolves.toBe(true);
    expect(JSON.parse(readFileSync(pricingPath, 'utf8'))).toEqual([]);
    await expect(store.delete('p1', 'm1')).resolves.toBe(false);
  });
});
