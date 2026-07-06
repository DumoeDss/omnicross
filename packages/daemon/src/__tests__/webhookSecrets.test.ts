import type { WebhookConfig } from '@omnicross/contracts/webhook-types';
import { describe, expect, it } from 'vitest';

import type { OutboundApiServerConfig } from '@omnicross/core';

import {
  preserveWebhookSecrets,
  redactWebhookConfig,
  validateWebhookSegment,
  WEBHOOK_SECRET_MASK,
} from '../admin/webhookConfigBody';
import {
  decryptWebhookSegment,
  encryptWebhookSegment,
} from '../secrets/secretFields';
import type { SecretBox } from '../secrets/SecretBox';

/** A fake at-rest box: `enc:` prefix codec, idempotent on already-encrypted. */
const fakeBox = {
  encryptMaybe: (v: string) => (v.startsWith('enc:') ? v : `enc:${v}`),
  decryptMaybe: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
} as unknown as SecretBox;

function cfg(destinations: WebhookConfig['destinations']): WebhookConfig {
  return { enabled: true, destinations };
}

describe('webhook secret walker — encrypt/decrypt at rest', () => {
  it('encrypts only the destination secret; other fields verbatim', () => {
    const input = cfg([
      { id: 'a', type: 'custom', url: 'https://x', secret: 'plain', enabled: true },
      { id: 'b', type: 'feishu', url: 'https://y', enabled: true },
    ]);
    const enc = encryptWebhookSegment(input, fakeBox);
    expect(enc.destinations[0].secret).toBe('enc:plain');
    expect(enc.destinations[0].url).toBe('https://x');
    expect(enc.destinations[1].secret).toBeUndefined();
    // Round-trips back to plaintext.
    expect(decryptWebhookSegment(enc, fakeBox).destinations[0].secret).toBe('plain');
  });

  it('is idempotent on an already-encrypted secret', () => {
    const enc = encryptWebhookSegment(cfg([{ id: 'a', type: 'custom', url: 'https://x', secret: 'enc:plain', enabled: true }]), fakeBox);
    expect(enc.destinations[0].secret).toBe('enc:plain');
  });
});

describe('redactWebhookConfig — mask secrets for the GET view', () => {
  it('replaces a present secret with the mask; leaves secret-less alone', () => {
    const out = redactWebhookConfig(
      cfg([
        { id: 'a', type: 'custom', url: 'https://x', secret: 'plain', enabled: true },
        { id: 'b', type: 'custom', url: 'https://y', enabled: true },
      ]),
    );
    expect(out.destinations[0].secret).toBe(WEBHOOK_SECRET_MASK);
    expect(out.destinations[1].secret).toBeUndefined();
    // The plaintext never appears in the redacted view.
    expect(JSON.stringify(out)).not.toContain('plain');
  });
});

describe('preserveWebhookSecrets — write-only secret preservation', () => {
  const current = cfg([{ id: 'a', type: 'custom', url: 'https://old', secret: 'stored', enabled: true }]);

  it('keeps the stored secret when the PUT sends the mask', () => {
    const incoming = cfg([{ id: 'a', type: 'custom', url: 'https://new', secret: WEBHOOK_SECRET_MASK, enabled: true }]);
    const out = preserveWebhookSecrets(incoming, current);
    expect(out.destinations[0]).toMatchObject({ url: 'https://new', secret: 'stored' });
  });

  it('keeps the stored secret when the PUT omits it', () => {
    const incoming = cfg([{ id: 'a', type: 'custom', url: 'https://new', enabled: true }]);
    expect(preserveWebhookSecrets(incoming, current).destinations[0].secret).toBe('stored');
  });

  it('accepts a genuinely new secret', () => {
    const incoming = cfg([{ id: 'a', type: 'custom', url: 'https://new', secret: 'rotated', enabled: true }]);
    expect(preserveWebhookSecrets(incoming, current).destinations[0].secret).toBe('rotated');
  });

  it('drops the mask sentinel for a NEW destination with no stored secret', () => {
    const incoming = cfg([{ id: 'new', type: 'custom', url: 'https://z', secret: WEBHOOK_SECRET_MASK, enabled: true }]);
    expect(preserveWebhookSecrets(incoming, current).destinations[0].secret).toBeUndefined();
  });
});

describe('validateWebhookSegment', () => {
  const patch = (webhook: unknown): Partial<OutboundApiServerConfig> => ({ webhook } as Partial<OutboundApiServerConfig>);

  it('accepts an absent segment (partial PUT) + a valid one', () => {
    expect(validateWebhookSegment({})).toEqual([]);
    expect(
      validateWebhookSegment(patch({ enabled: true, destinations: [{ id: 'a', type: 'custom', url: 'https://x', enabled: true }] })),
    ).toEqual([]);
  });

  it('rejects malformed segments + destinations', () => {
    expect(validateWebhookSegment(patch({ enabled: 'yes' })).length).toBeGreaterThan(0);
    expect(validateWebhookSegment(patch({ enabled: true, destinations: {} })).length).toBeGreaterThan(0);
    const errs = validateWebhookSegment(
      patch({ enabled: true, destinations: [{ id: '', type: 'nope', url: '', events: ['bad'] }] }),
    );
    expect(errs.some((e) => e.includes('.id'))).toBe(true);
    expect(errs.some((e) => e.includes('.type'))).toBe(true);
    expect(errs.some((e) => e.includes('.url'))).toBe(true);
    expect(errs.some((e) => e.includes('events'))).toBe(true);
  });

  it('rejects duplicate destination ids', () => {
    const errs = validateWebhookSegment(
      patch({
        enabled: true,
        destinations: [
          { id: 'a', type: 'custom', url: 'https://x', enabled: true },
          { id: 'a', type: 'custom', url: 'https://y', enabled: true },
        ],
      }),
    );
    expect(errs.some((e) => e.includes('duplicated'))).toBe(true);
  });
});
