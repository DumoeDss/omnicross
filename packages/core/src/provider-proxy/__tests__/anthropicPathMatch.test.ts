/**
 * Table-driven unit tests for the shared Anthropic Messages path classifier
 * (`claude-api-routing-errors`, capability anthropic-endpoint-routing).
 *
 * Enumerates every case named in the spec: the messages root (incl. trailing
 * slash / query string / provider prefix), the count_tokens variants, other
 * subpaths, and the lookalikes that MUST NOT match (`/v1/messagesfoo`, bare
 * `/messages`, `/v1beta/...`, and the unfolded doubled tail which stays
 * `'messages'` for resident-face parity).
 *
 * @module provider-proxy/__tests__/anthropicPathMatch.test
 */

import { describe, expect, it } from 'vitest';

import { classifyAnthropicMessagesPath } from '../ingress/anthropicPathMatch';

describe('classifyAnthropicMessagesPath', () => {
  it.each([
    // ── ② the messages root (exact, tolerant of slash/query/prefix) ──────────
    ['/v1/messages', 'messages'],
    ['/v1/messages/', 'messages'],
    ['/v1/messages?beta=true', 'messages'],
    ['/anthropic/v1/messages', 'messages'],
    ['/anthropic/v1/messages/?beta=true', 'messages'],
    // Unfolded doubled tail (resident face has no entry folding) stays
    // 'messages' — parity with the pre-change `includes` behavior.
    ['/v1/messages/v1/messages', 'messages'],
    ['/v1/messages/v1/messages?beta=true', 'messages'],
    // ── ① count_tokens ───────────────────────────────────────────────────────
    ['/v1/messages/count_tokens', 'count_tokens'],
    ['/v1/messages/count_tokens/', 'count_tokens'],
    ['/v1/messages/count_tokens?beta=true', 'count_tokens'],
    ['/anthropic/v1/messages/count_tokens', 'count_tokens'],
    // ── ③ other subpaths ─────────────────────────────────────────────────────
    ['/v1/messages/batches', 'unsupported-subpath'],
    ['/v1/messages/batches/msg_123', 'unsupported-subpath'],
    ['/v1/messages/count_tokensfoo', 'unsupported-subpath'],
    // ── ④ lookalikes that must NOT match ─────────────────────────────────────
    ['/v1/messagesfoo', null],
    ['/messages', null],
    ['/v1beta/messages', null],
    ['/v1beta/models/gemini-2.5-pro:generateContent', null],
    ['/v1/chat/completions', null],
    ['/v1/responses', null],
    ['/health', null],
    ['', null],
    [undefined, null],
  ] as [string | undefined, string | null][])('classifies %s', (url, expected) => {
    expect(classifyAnthropicMessagesPath(url)).toBe(expected);
  });
});
