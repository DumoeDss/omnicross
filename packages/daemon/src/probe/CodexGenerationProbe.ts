/**
 * Manual, end-to-end Codex account probe.
 *
 * This is deliberately separate from the scheduled cheap probe: every call
 * performs a real model generation and therefore consumes subscription quota.
 */

import {
  DEFAULT_CODEX_CLI_HEADERS,
  codexAcceptHeader,
} from '@omnicross/core/provider-proxy/identity/codexCliHeaders';

export const CODEX_GENERATION_PROBE_MODEL = 'gpt-5.6-luna';
export const CODEX_GENERATION_PROBE_URL = 'https://chatgpt.com/backend-api/codex/responses';

const MAX_STREAM_BYTES = 256 * 1024;
const PROBE_INSTRUCTION = 'Return exactly PONG and no other text.';

/** Build the same private Responses shape used by the serving Codex path. */
export function buildCodexGenerationProbeInit(token: string, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    signal,
    headers: {
      ...DEFAULT_CODEX_CLI_HEADERS,
      Authorization: `Bearer ${token}`,
      Accept: codexAcceptHeader(true),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CODEX_GENERATION_PROBE_MODEL,
      input: [
        {
          role: 'developer',
          content: [{ type: 'input_text', text: PROBE_INSTRUCTION }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Connection probe.' }],
        },
      ],
      // GPT-5.6 otherwise defaults to medium reasoning. A connectivity probe
      // needs the lowest-cost path and no tool reasoning.
      reasoning: { effort: 'none' },
      stream: true,
      store: false,
    }),
  };
}

export interface CodexGenerationStreamResult {
  completed: boolean;
  outputChars: number;
}

/**
 * Read a bounded Codex SSE response and require both the terminal completion
 * event and real assistant text. The text itself is never returned or stored.
 */
export async function readCodexGenerationProbeStream(
  response: Response,
): Promise<CodexGenerationStreamResult> {
  if (!response.body) return { completed: false, outputChars: 0 };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let outputChars = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_BYTES) {
        await reader.cancel();
        return { completed: false, outputChars };
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          const type = event['type'];
          if (type === 'response.output_text.delta' && typeof event['delta'] === 'string') {
            outputChars += event['delta'].length;
          } else if (type === 'response.output_text.done' && typeof event['text'] === 'string') {
            outputChars = Math.max(outputChars, event['text'].length);
          } else if (type === 'response.failed' || type === 'error') {
            await reader.cancel();
            return { completed: false, outputChars };
          } else if (type === 'response.completed') {
            const completedResponse = asRecord(event['response']);
            const status = completedResponse?.['status'];
            outputChars = Math.max(outputChars, countCompletedOutputChars(completedResponse));
            await reader.cancel();
            return {
              completed: (status === undefined || status === 'completed') && outputChars > 0,
              outputChars,
            };
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    return { completed: false, outputChars };
  } finally {
    reader.releaseLock();
  }

  return { completed: false, outputChars };
}

function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function countCompletedOutputChars(response: Record<string, unknown> | undefined): number {
  const output = response?.['output'];
  if (!Array.isArray(output)) return 0;
  let chars = 0;
  for (const item of output) {
    const content = asRecord(item)?.['content'];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const record = asRecord(part);
      if (record?.['type'] === 'output_text' && typeof record['text'] === 'string') {
        chars += record['text'].length;
      }
    }
  }
  return chars;
}
