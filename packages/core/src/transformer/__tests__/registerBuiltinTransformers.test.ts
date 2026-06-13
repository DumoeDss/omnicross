/**
 * registerBuiltinTransformers completeness contract
 *
 * Machine-guards the registration contract introduced by the
 * `llm-transformer-contract` change (Candidate (a)): the single
 * `registerBuiltinTransformers` entry point seeds a TransformerService with
 * EXACTLY the built-in set named by BUILTIN_TRANSFORMER_NAMES — no more, no
 * fewer — and the `BuiltinTransformers` record agrees with that name list.
 *
 * This turns today's implicit "the record and the names agree" invariant into a
 * fail-fast guard so future provider/format work can lean on a complete,
 * tested registration contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILTIN_TRANSFORMER_NAMES,
  BuiltinTransformers,
  registerBuiltinTransformers,
} from '../transformers';
import { TransformerService } from '../TransformerService';
import type { TransformerLogger } from '../types';

// Suppress the registration / summary log output during the test.
const mockLogger: TransformerLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('registerBuiltinTransformers (registration contract)', () => {
  let service: TransformerService;

  beforeEach(() => {
    service = new TransformerService(mockLogger);
  });

  it('registers exactly the BUILTIN_TRANSFORMER_NAMES set (no more, no fewer)', async () => {
    await registerBuiltinTransformers(service);

    const registered = service.getTransformerNames().sort();
    const expected = [...BUILTIN_TRANSFORMER_NAMES].sort();

    expect(registered).toEqual(expected);
  });

  it('resolves every name in BUILTIN_TRANSFORMER_NAMES via hasTransformer', async () => {
    await registerBuiltinTransformers(service);

    for (const name of BUILTIN_TRANSFORMER_NAMES) {
      expect(service.hasTransformer(name)).toBe(true);
    }
  });

  it('keeps the BuiltinTransformers record and the name list in agreement', () => {
    // Record entry count equals the declared name count.
    expect(Object.keys(BuiltinTransformers).length).toBe(BUILTIN_TRANSFORMER_NAMES.length);
  });

  it('every registered builtin name is declared in BUILTIN_TRANSFORMER_NAMES', async () => {
    await registerBuiltinTransformers(service);

    const declared = new Set<string>(BUILTIN_TRANSFORMER_NAMES);
    for (const name of service.getTransformerNames()) {
      expect(declared.has(name)).toBe(true);
    }
  });
});
