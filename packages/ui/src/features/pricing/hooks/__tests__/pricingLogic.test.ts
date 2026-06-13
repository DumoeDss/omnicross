/**
 * pricingLogic tests — client-side validation gating (mirrors the daemon's
 * PUT rules), the search filter, and the conflict decision machine: default
 * SKIP, bulk set-all, the stateless echo submit body (mixed decisions), and
 * decision immutability (a failed submit reuses the untouched map).
 */
import { describe, expect, it } from 'vitest';

import {
  buildResolutions,
  conflictKey,
  draftFromEntry,
  EMPTY_DRAFT,
  filterEntries,
  initDecisions,
  setAllDecisions,
  setDecision,
  validateDraft,
  type PricingDraft,
} from '../pricingLogic';

import type { PricingConflict, PricingEntry } from '../../../../daemon/types-usage-pricing';

const VALID_DRAFT: PricingDraft = {
  providerId: 'p1',
  modelId: 'vendor/model-a',
  inputPricePer1m: '3',
  outputPricePer1m: '15',
  cacheReadPricePer1m: '',
  cacheWritePricePer1m: '0.5',
};

const entry = (providerId: string, modelId: string, over?: Partial<PricingEntry>): PricingEntry => ({
  providerId,
  modelId,
  inputPricePer1m: 1,
  outputPricePer1m: 2,
  cacheReadPricePer1m: null,
  cacheWritePricePer1m: null,
  source: 'user',
  userEdited: true,
  editedAt: 1,
  updatedAt: 2,
  ...over,
});

const conflict = (providerId: string, modelId: string): PricingConflict => ({
  providerId,
  modelId,
  current: entry(providerId, modelId),
  incoming: { providerId, modelId, inputPricePer1m: 9, outputPricePer1m: 10 },
});

describe('validateDraft', () => {
  it('accepts a valid draft; empty cache price → null, present one → number', () => {
    const result = validateDraft(VALID_DRAFT);
    expect(result.ok).toBe(true);
    expect(result.input).toEqual({
      providerId: 'p1',
      modelId: 'vendor/model-a',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      cacheReadPricePer1m: null,
      cacheWritePricePer1m: 0.5,
    });
  });

  it('blocks missing ids with field-level errors', () => {
    const result = validateDraft({ ...VALID_DRAFT, providerId: '  ', modelId: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.providerId).toBe('pricing.requiredId');
    expect(result.errors.modelId).toBe('pricing.requiredId');
    expect(result.input).toBeUndefined();
  });

  it('blocks non-numeric and negative required prices', () => {
    expect(validateDraft({ ...VALID_DRAFT, inputPricePer1m: 'abc' }).ok).toBe(false);
    expect(validateDraft({ ...VALID_DRAFT, outputPricePer1m: '-1' }).ok).toBe(false);
    expect(validateDraft({ ...VALID_DRAFT, inputPricePer1m: '' }).ok).toBe(false);
    expect(validateDraft({ ...VALID_DRAFT, inputPricePer1m: 'Infinity' }).ok).toBe(false);
  });

  it('blocks PRESENT-but-non-numeric optional cache prices (daemon 400 mirror)', () => {
    const result = validateDraft({ ...VALID_DRAFT, cacheReadPricePer1m: 'oops' });
    expect(result.ok).toBe(false);
    expect(result.errors.cacheReadPricePer1m).toBe('pricing.invalidPrice');
  });

  it('zero prices are allowed (free models exist)', () => {
    expect(validateDraft({ ...VALID_DRAFT, inputPricePer1m: '0', outputPricePer1m: '0' }).ok).toBe(true);
  });
});

describe('draftFromEntry', () => {
  it('round-trips an entry through the editor draft (null cache → empty string)', () => {
    const e = entry('p', 'm', { cacheReadPricePer1m: 0.3 });
    const draft = draftFromEntry(e);
    expect(draft.cacheReadPricePer1m).toBe('0.3');
    expect(draft.cacheWritePricePer1m).toBe('');
    const result = validateDraft(draft);
    expect(result.ok).toBe(true);
    expect(result.input!.cacheWritePricePer1m).toBeNull();
  });

  it('EMPTY_DRAFT does not validate (add-entry starts blocked)', () => {
    expect(validateDraft(EMPTY_DRAFT).ok).toBe(false);
  });
});

describe('filterEntries', () => {
  const entries = [entry('openrouter', 'vendor/Model-A'), entry('other', 'something-else')];

  it('matches case-insensitively across providerId and modelId', () => {
    expect(filterEntries(entries, 'model-a')).toHaveLength(1);
    expect(filterEntries(entries, 'OPENROUTER')).toHaveLength(1);
    expect(filterEntries(entries, 'ELSE')).toHaveLength(1);
  });

  it('empty/whitespace search returns all rows', () => {
    expect(filterEntries(entries, '')).toHaveLength(2);
    expect(filterEntries(entries, '   ')).toHaveLength(2);
  });
});

describe('conflict decision machine', () => {
  const conflicts = [conflict('p1', 'm1'), conflict('p2', 'vendor/m2')];

  it('initDecisions defaults EVERY row to skip (protect user edits)', () => {
    const decisions = initDecisions(conflicts);
    expect(Object.values(decisions)).toEqual(['skip', 'skip']);
  });

  it('setDecision flips one row without mutating the previous map', () => {
    const initial = initDecisions(conflicts);
    const next = setDecision(initial, conflictKey(conflicts[0]!), 'overwrite');
    expect(next[conflictKey(conflicts[0]!)]).toBe('overwrite');
    expect(next[conflictKey(conflicts[1]!)]).toBe('skip');
    // Failure-preserves-decisions invariant: the prior map is untouched.
    expect(initial[conflictKey(conflicts[0]!)]).toBe('skip');
  });

  it('setAllDecisions applies a bulk overwrite-all / skip-all', () => {
    expect(Object.values(setAllDecisions(conflicts, 'overwrite'))).toEqual(['overwrite', 'overwrite']);
    expect(Object.values(setAllDecisions(conflicts, 'skip'))).toEqual(['skip', 'skip']);
  });

  it('buildResolutions submits a mixed body with top-level ids + verbatim incoming echo', () => {
    const decisions = setDecision(initDecisions(conflicts), conflictKey(conflicts[0]!), 'overwrite');
    const body = buildResolutions(conflicts, decisions);
    expect(body).toEqual([
      { providerId: 'p1', modelId: 'm1', action: 'overwrite', incoming: conflicts[0]!.incoming },
      { providerId: 'p2', modelId: 'vendor/m2', action: 'skip', incoming: conflicts[1]!.incoming },
    ]);
    // ids consistent with the echo; incoming is the SAME object (verbatim).
    expect(body[0]!.incoming).toBe(conflicts[0]!.incoming);
    for (const r of body) {
      expect(r.providerId).toBe(r.incoming.providerId);
      expect(r.modelId).toBe(r.incoming.modelId);
    }
  });

  it('buildResolutions falls back to skip for an unknown key (never invents overwrite)', () => {
    const body = buildResolutions(conflicts, {});
    expect(body.every((r) => r.action === 'skip')).toBe(true);
  });
});
