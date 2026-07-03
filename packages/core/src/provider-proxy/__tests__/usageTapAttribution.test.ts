/**
 * Usage-tap apiKeyId forwarding (omnicross-udash-attrib, D4). Each non-stream
 * tap forwards `attribution.apiKeyId` into `recorder.record({ apiKeyId })` — a
 * real id when the outbound route carried one, `null` for internal traffic.
 */
import { describe, expect, it } from 'vitest';

import { recordAnthropicNonStreamUsage } from '../usage/recordAnthropicUsage';
import { recordChatCompletionsNonStreamUsage } from '../usage/recordChatCompletionsUsage';
import { recordGeminiNonStreamUsage } from '../usage/recordGeminiUsage';
import { recordResponsesNonStreamUsage } from '../usage/recordResponsesUsage';
import type { UsageRecordImportInput, UsageRecorderImport } from '../types';

function capturingRecorder(): { recorder: UsageRecorderImport; calls: UsageRecordImportInput[] } {
  const calls: UsageRecordImportInput[] = [];
  return { recorder: { record: (input) => calls.push(input) }, calls };
}

const ANTHROPIC_BODY = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
const RESPONSES_BODY = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
const CHAT_BODY = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
const GEMINI_BODY = JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

const cases: Array<{
  name: string;
  run: (r: UsageRecorderImport, apiKeyId: string | null) => void;
}> = [
  {
    name: 'anthropic',
    run: (r, apiKeyId) =>
      recordAnthropicNonStreamUsage(r, ANTHROPIC_BODY, {
        sessionId: 's',
        providerId: 'anthropic',
        model: 'm',
        apiKeyId,
      }),
  },
  {
    name: 'responses',
    run: (r, apiKeyId) =>
      recordResponsesNonStreamUsage(r, RESPONSES_BODY, {
        sessionId: 's',
        providerId: 'codex',
        model: 'm',
        apiKeyId,
      }),
  },
  {
    name: 'chat',
    run: (r, apiKeyId) =>
      recordChatCompletionsNonStreamUsage(r, CHAT_BODY, {
        sessionId: 's',
        providerId: 'openai',
        model: 'm',
        apiKeyId,
      }),
  },
  {
    name: 'gemini',
    run: (r, apiKeyId) =>
      recordGeminiNonStreamUsage(r, GEMINI_BODY, {
        sessionId: 's',
        providerId: 'gemini',
        model: 'm',
        apiKeyId,
      }),
  },
];

describe('usage taps — apiKeyId forwarding', () => {
  for (const c of cases) {
    it(`${c.name} tap records the attributed apiKeyId`, () => {
      const { recorder, calls } = capturingRecorder();
      c.run(recorder, 'key-123');
      expect(calls).toHaveLength(1);
      expect(calls[0].apiKeyId).toBe('key-123');
    });

    it(`${c.name} tap records null when unattributed`, () => {
      const { recorder, calls } = capturingRecorder();
      c.run(recorder, null);
      expect(calls).toHaveLength(1);
      expect(calls[0].apiKeyId).toBeNull();
    });
  }
});
