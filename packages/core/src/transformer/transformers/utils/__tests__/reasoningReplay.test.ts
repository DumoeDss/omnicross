/**
 * reasoningReplay — classification, rejection matching, and the wire rewrites.
 *
 * The static gate must let the DeepSeek v4 family in and keep legacy
 * deepseek-reasoner (which FORBIDS `reasoning_content` in input) out; the
 * matchers drive both the driver's learning and its strip-and-retry recovery.
 *
 * @module transformer/transformers/utils/__tests__/reasoningReplay.test
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyReasoningReplay,
  isReasoningContentForbidden,
  isReasoningReplayLearned,
  isReasoningReplayProvider,
  isReasoningReplayRejection,
  markReasoningReplayRequired,
  reasoningReplayKey,
  resetReasoningReplayStateForTests,
  stripReasoningReplay,
} from '../reasoningReplay';

afterEach(() => resetReasoningReplayStateForTests());

const deepseek = { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' };
const zai = { name: 'z-ai', baseUrl: 'https://api.z.ai' };

describe('isReasoningReplayProvider', () => {
  it('classifies DeepSeek v4-era models (discrete thinking levels)', () => {
    for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
      expect(isReasoningReplayProvider(deepseek, model)).toBe(true);
    }
  });

  it('keeps legacy DeepSeek models out — they forbid reasoning_content in input', () => {
    // deepseek-reasoner aliases deepseek-r1; deepseek-chat aliases v3.
    for (const model of ['deepseek-r1', 'deepseek-reasoner', 'deepseek-chat', 'deepseek-v3']) {
      expect(isReasoningReplayProvider(deepseek, model)).toBe(false);
    }
  });

  it('requires DeepSeek identity — a deepseek model on another provider stays out', () => {
    expect(isReasoningReplayProvider(zai, 'deepseek-flash')).toBe(false);
    expect(isReasoningReplayProvider(undefined, 'deepseek-flash')).toBe(false);
  });
});

describe('rejection matchers', () => {
  const liveError =
    '{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API. (request_id: 5f13e5ad)","type":"invalid_request_error"}}';

  it('recognizes the live thinking-mode passback demand', () => {
    expect(isReasoningReplayRejection(400, liveError)).toBe(true);
  });

  it('does not arm on unrelated 400s or other statuses', () => {
    expect(isReasoningReplayRejection(400, '{"error":{"message":"Invalid parameter"}}')).toBe(false);
    expect(isReasoningReplayRejection(500, liveError)).toBe(false);
    expect(isReasoningReplayRejection(400, '')).toBe(false);
  });

  it('recognizes the mirror rejection — reasoning_content forbidden in input', () => {
    expect(
      isReasoningContentForbidden(
        400,
        'reasoning_content is not allowed in input messages',
      ),
    ).toBe(true);
    // The passback DEMAND is not a forbiddance.
    expect(isReasoningContentForbidden(400, liveError)).toBe(false);
  });
});

describe('learned registry', () => {
  it('marks and reads back a provider key', () => {
    const key = reasoningReplayKey(zai);
    expect(isReasoningReplayLearned(key)).toBe(false);
    markReasoningReplayRequired(key);
    expect(isReasoningReplayLearned(key)).toBe(true);
  });

  it('keys on normalized provider identity', () => {
    expect(reasoningReplayKey({ name: 'Z-AI', baseUrl: undefined })).toBe(
      reasoningReplayKey({ name: 'z-ai', baseUrl: undefined }),
    );
  });
});

describe('wire rewrites', () => {
  it('applies replay entries to their assistant messages only', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'one' },
        { role: 'tool', content: 'out', tool_call_id: 'c1' },
        { role: 'assistant', content: null, tool_calls: [] },
      ],
    };
    applyReasoningReplay(body, [
      { messageIndex: 1, text: 'think one' },
      { messageIndex: 3, text: 'think two' },
      // Out-of-range and empty-text entries are ignored.
      { messageIndex: 9, text: 'ghost' },
      { messageIndex: 0, text: '' },
    ]);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0].reasoning_content).toBeUndefined();
    expect(messages[1].reasoning_content).toBe('think one');
    expect(messages[2].reasoning_content).toBeUndefined();
    expect(messages[3].reasoning_content).toBe('think two');
  });

  it('strips every reasoning_content and reports whether anything changed', () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'assistant', content: 'one', reasoning_content: 'a' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(stripReasoningReplay(body)).toBe(true);
    expect((body.messages as Array<Record<string, unknown>>)[0].reasoning_content).toBeUndefined();
    expect(stripReasoningReplay(body)).toBe(false);
  });
});
