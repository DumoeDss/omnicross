import type { BillingConfig } from '@omnicross/contracts/billing-types';
import type { OutboundApiServerConfig } from '@omnicross/core';
import { describe, expect, it } from 'vitest';

import {
  BILLING_SECRET_MASK,
  preserveBillingSecret,
  redactBillingConfig,
  validateBillingSegment,
} from '../admin/billingConfigBody';
import { decryptBillingSegment, encryptBillingSegment } from '../secrets/secretFields';
import type { SecretBox } from '../secrets/SecretBox';

/** A fake at-rest box: `enc:` prefix codec, idempotent on already-encrypted. */
const fakeBox = {
  encryptMaybe: (v: string) => (v.startsWith('enc:') ? v : `enc:${v}`),
  decryptMaybe: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
} as unknown as SecretBox;

const cfg = (over: Partial<BillingConfig> = {}): BillingConfig => ({
  enabled: true,
  maxRetryAgeMs: 24 * 60 * 60_000,
  ...over,
});

describe('billing secret walker — encrypt/decrypt at rest', () => {
  it('encrypts only the HMAC secret; other fields verbatim', () => {
    const enc = encryptBillingSegment(cfg({ endpoint: 'https://sink', secret: 'plain' }), fakeBox);
    expect(enc.secret).toBe('enc:plain');
    expect(enc.endpoint).toBe('https://sink');
    expect(enc.enabled).toBe(true);
    expect(decryptBillingSegment(enc, fakeBox).secret).toBe('plain');
  });

  it('is a no-op when there is no secret (ledger-only / secret-less)', () => {
    const input = cfg({ endpoint: 'https://sink' });
    expect(encryptBillingSegment(input, fakeBox)).toBe(input);
  });

  it('is idempotent on an already-encrypted secret', () => {
    expect(encryptBillingSegment(cfg({ secret: 'enc:plain' }), fakeBox).secret).toBe('enc:plain');
  });
});

describe('redactBillingConfig — mask the secret for the GET view', () => {
  it('replaces a present secret with the mask; leaves secret-less alone', () => {
    const out = redactBillingConfig(cfg({ endpoint: 'https://sink', secret: 'plain' }));
    expect(out.secret).toBe(BILLING_SECRET_MASK);
    expect(JSON.stringify(out)).not.toContain('plain');
    expect(redactBillingConfig(cfg({ endpoint: 'https://sink' })).secret).toBeUndefined();
  });
});

describe('preserveBillingSecret — write-only secret preservation', () => {
  const current = cfg({ endpoint: 'https://old', secret: 'stored' });

  it('keeps the stored secret when the PUT sends the mask', () => {
    const out = preserveBillingSecret(cfg({ endpoint: 'https://new', secret: BILLING_SECRET_MASK }), current);
    expect(out).toMatchObject({ endpoint: 'https://new', secret: 'stored' });
  });

  it('keeps the stored secret when the PUT omits it', () => {
    expect(preserveBillingSecret(cfg({ endpoint: 'https://new' }), current).secret).toBe('stored');
  });

  it('accepts a genuinely new secret', () => {
    expect(preserveBillingSecret(cfg({ secret: 'rotated' }), current).secret).toBe('rotated');
  });

  it('drops the mask sentinel when there is no stored secret', () => {
    expect(preserveBillingSecret(cfg({ secret: BILLING_SECRET_MASK }), undefined).secret).toBeUndefined();
  });
});

describe('validateBillingSegment', () => {
  const patch = (billing: unknown): Partial<OutboundApiServerConfig> =>
    ({ billing } as Partial<OutboundApiServerConfig>);

  it('accepts an absent segment (partial PUT) + a valid one', () => {
    expect(validateBillingSegment({})).toEqual([]);
    expect(validateBillingSegment(patch({ enabled: true, endpoint: 'https://x', maxRetryAgeMs: 3600000 }))).toEqual([]);
  });

  it('rejects malformed fields', () => {
    expect(validateBillingSegment(patch({ enabled: 'yes' })).length).toBeGreaterThan(0);
    expect(validateBillingSegment(patch({ endpoint: 123 })).length).toBeGreaterThan(0);
    expect(validateBillingSegment(patch({ secret: 5 })).length).toBeGreaterThan(0);
    expect(validateBillingSegment(patch({ maxRetryAgeMs: -1 })).length).toBeGreaterThan(0);
  });
});
