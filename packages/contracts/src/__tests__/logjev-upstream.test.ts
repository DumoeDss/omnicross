/**
 * parseLogJevSettings upstream tests — the LogJev-as-selector reference
 * (`logjev.upstream = { kind: 'provider', id, model }`): valid references
 * parse + round-trip verbatim; malformed ones fail with a clear message.
 */
import { describe, expect, it } from 'vitest';

import { parseLogJevSettings } from '../logjev';

describe('parseLogJevSettings (upstream reference)', () => {
  it('parses a valid provider reference and round-trips it verbatim', () => {
    const parsed = parseLogJevSettings({
      kind: 'chat',
      upstream: { kind: 'provider', id: 'nim', model: 'deepseek-v4' },
      topk: 10,
    });
    expect(parsed.upstream).toEqual({ kind: 'provider', id: 'nim', model: 'deepseek-v4' });
    expect(parsed.topk).toBe(10);
  });

  it('rejects a wrong kind, empty id, or empty model', () => {
    expect(() => parseLogJevSettings({ kind: 'chat', upstream: { kind: 'account', id: 'x', model: 'y' } })).toThrow(/upstream/);
    expect(() => parseLogJevSettings({ kind: 'chat', upstream: { kind: 'provider', id: '  ', model: 'y' } })).toThrow(/upstream/);
    expect(() => parseLogJevSettings({ kind: 'chat', upstream: { kind: 'provider', id: 'x' } })).toThrow(/upstream/);
  });

  it('keeps a reference-less settings block unchanged (legacy rows)', () => {
    const parsed = parseLogJevSettings({ kind: 'chat', promptMode: 'minimal', topk: 5 });
    expect(parsed.upstream).toBeUndefined();
    expect(parsed.promptMode).toBe('minimal');
  });
});
