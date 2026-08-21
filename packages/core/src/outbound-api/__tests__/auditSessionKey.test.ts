import { describe, expect, it } from 'vitest';

import { deriveAuditSessionKey } from '../auditSessionKey';

const HEX32 = /^[0-9a-f]{32}$/;

describe('deriveAuditSessionKey', () => {
  it('always returns a bare lowercase-hex digest (safe as a shard file name)', () => {
    expect(deriveAuditSessionKey({}, {}, { fallbackKey: 'oak_1' })).toMatch(HEX32);
  });

  it('uses the session id Claude Code embeds in Anthropic metadata.user_id', () => {
    const body = (session: string): Record<string, unknown> => ({
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: `user_abc123_account__session_${session}` },
    });
    const a = deriveAuditSessionKey(body('11111111-2222-3333-4444-555555555555'), {});
    const b = deriveAuditSessionKey(body('11111111-2222-3333-4444-555555555555'), {});
    const c = deriveAuditSessionKey(body('99999999-8888-7777-6666-555555555555'), {});
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('is stable as an Anthropic conversation grows turn over turn', () => {
    const withTurns = (n: number): Record<string, unknown> => ({
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'first question' },
        ...Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: `reply ${i}` })),
      ],
    });
    const first = deriveAuditSessionKey(withTurns(0), {});
    expect(deriveAuditSessionKey(withTurns(3), {})).toBe(first);
    expect(deriveAuditSessionKey(withTurns(20), {})).toBe(first);
  });

  it('separates two Anthropic conversations that share a system prompt', () => {
    const conv = (firstUser: string): Record<string, unknown> => ({
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: firstUser }],
    });
    expect(deriveAuditSessionKey(conv('about cats'), {})).not.toBe(
      deriveAuditSessionKey(conv('about dogs'), {}),
    );
  });

  it('honours the Codex session-id header', () => {
    const headers = { 'session-id': '7f3a1c00-0000-4000-8000-000000000001' };
    const a = deriveAuditSessionKey({ input: 'hello' }, headers);
    const b = deriveAuditSessionKey({ input: 'a much later turn' }, headers);
    expect(a).toBe(b);
    expect(a).not.toBe(deriveAuditSessionKey({ input: 'hello' }, { 'session-id': 'other' }));
  });

  it('honours an explicit body conversation id', () => {
    const a = deriveAuditSessionKey({ conversation_id: 'conv-1', input: 'x' }, {});
    const b = deriveAuditSessionKey({ conversation_id: 'conv-1', input: 'y' }, {});
    expect(a).toBe(b);
  });

  it('falls back to a route-scoped seed rather than colliding everything', () => {
    const a = deriveAuditSessionKey({}, {}, { fallbackKey: 'oak_1', endpoint: 'messages' });
    const b = deriveAuditSessionKey({}, {}, { fallbackKey: 'oak_2', endpoint: 'messages' });
    expect(a).not.toBe(b);
    expect(deriveAuditSessionKey({}, {}, { fallbackKey: 'oak_1', endpoint: 'messages' })).toBe(a);
  });

  it('never leaks the raw identifier it derived from', () => {
    const raw = 'super-secret-session-marker';
    const key = deriveAuditSessionKey({ session_id: raw }, {});
    expect(key).not.toContain(raw);
    expect(key).toMatch(HEX32);
  });
});
