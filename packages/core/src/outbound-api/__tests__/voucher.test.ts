/**
 * Unit tests for the PURE voucher helpers (voucher-redemption #9): code
 * generation (credential — distinct, `CC_` prefixed, hash ≠ plaintext), the grant
 * computation with per-card anti-abuse caps (design D5), and the admin-safe DTO
 * projection (never leaks the code hash).
 */
import { describe, expect, it } from 'vitest';

import type { VoucherRecord } from '@omnicross/contracts/voucher-types';

import {
  computeVoucherGrant,
  generateVoucherCode,
  hashVoucherCode,
  toVoucherInfo,
  voucherCodePrefix,
} from '../voucher';

const DAY = 86_400_000;

function card(overrides: Partial<VoucherRecord>): VoucherRecord {
  return {
    id: 'vch_1',
    codeHash: 'h',
    codePrefix: 'CC_AB',
    type: 'credit',
    status: 'unredeemed',
    createdAt: 0,
    ...overrides,
  };
}

describe('voucher code generation', () => {
  it('produces a CC_-prefixed high-entropy code, distinct each time', () => {
    const a = generateVoucherCode();
    const b = generateVoucherCode();
    expect(a.startsWith('CC_')).toBe(true);
    expect(b.startsWith('CC_')).toBe(true);
    expect(a).not.toBe(b);
    // CC_ + 32 base62 chars.
    expect(a.length).toBe(3 + 32);
  });

  it('hashes to a value that is NOT the plaintext and is stable', () => {
    const code = generateVoucherCode();
    const hash = hashVoucherCode(code);
    expect(hash).not.toContain(code);
    expect(hash).not.toContain('CC_');
    expect(hash).toBe(hashVoucherCode(code)); // deterministic
    expect(hash).toHaveLength(64); // sha256 hex
  });

  it('derives a short display prefix that omits most of the code', () => {
    const code = 'CC_ABCDEFGHIJKLMNOP';
    expect(voucherCodePrefix(code)).toBe('CC_ABCDE');
    expect(code.startsWith(voucherCodePrefix(code))).toBe(true);
  });
});

describe('computeVoucherGrant — credit', () => {
  it('adds credit onto the current total limit', () => {
    const g = computeVoucherGrant(card({ type: 'credit', creditUsd: 20 }), { totalCostLimitUsd: 5 }, 0);
    expect(g).toEqual({ totalCostLimitUsd: 25 });
  });

  it('treats an absent current limit as 0', () => {
    const g = computeVoucherGrant(card({ type: 'credit', creditUsd: 20 }), null, 0);
    expect(g).toEqual({ totalCostLimitUsd: 20 });
  });

  it('clamps the resulting limit to the per-card cap', () => {
    const g = computeVoucherGrant(
      card({ type: 'credit', creditUsd: 100, maxTotalCostLimitUsd: 50 }),
      { totalCostLimitUsd: 10 },
      0,
    );
    expect(g).toEqual({ totalCostLimitUsd: 50 });
  });
});

describe('computeVoucherGrant — renewal', () => {
  it('extends the current expiry by the card days', () => {
    const now = 1_000_000;
    const g = computeVoucherGrant(
      card({ type: 'renewal', renewalDays: 30 }),
      { expiresAt: now + 5 * DAY },
      now,
    );
    expect(g).toEqual({ expiresAt: now + 35 * DAY });
  });

  it('extends from now when the key has no expiry', () => {
    const now = 1_000_000;
    const g = computeVoucherGrant(card({ type: 'renewal', renewalDays: 10 }), {}, now);
    expect(g).toEqual({ expiresAt: now + 10 * DAY });
  });

  it('clamps the resulting expiry to now + maxExpiryDays', () => {
    const now = 1_000_000;
    const g = computeVoucherGrant(
      card({ type: 'renewal', renewalDays: 365, maxExpiryDays: 30 }),
      { expiresAt: now },
      now,
    );
    expect(g).toEqual({ expiresAt: now + 30 * DAY });
  });
});

describe('toVoucherInfo', () => {
  it('projects a safe DTO that NEVER carries the code hash', () => {
    const info = toVoucherInfo(
      card({ codeHash: 'SECRETHASH', creditUsd: 20, redeemedByKeyId: 'oak_1' }),
    );
    expect(JSON.stringify(info)).not.toContain('SECRETHASH');
    expect('codeHash' in info).toBe(false);
    expect(info.codePrefix).toBe('CC_AB');
    expect(info.creditUsd).toBe(20);
  });
});
