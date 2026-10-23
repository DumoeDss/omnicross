import type { TransformerLogger } from '../types';

function isSSEObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Decode complete SSE events, including CRLF, multiline data and a final unterminated frame. */
export async function readAnthropicSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (event: Record<string, unknown>) => boolean | void,
  logger?: TransformerLogger,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let stopped = false;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') { stopped = true; return; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      logger?.error('Invalid upstream SSE JSON:', error);
      throw new Error('Invalid upstream SSE JSON');
    }
    if (!isSSEObject(parsed)) throw new Error('Invalid upstream SSE JSON: expected an object');
    if (consume(parsed) === false) stopped = true;
  };
  const line = (value: string) => {
    if (!value) dispatch();
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  while (!stopped) {
    const result = await reader.read();
    buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
    let start = 0;
    for (let i = 0; i < buffer.length && !stopped; i++) {
      if (buffer[i] !== '\n' && buffer[i] !== '\r') continue;
      if (buffer[i] === '\r' && i === buffer.length - 1 && !result.done) break;
      line(buffer.slice(start, i));
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (result.done) {
      if (buffer && !stopped) line(buffer);
      if (!stopped) dispatch();
      break;
    }
  }
  if (stopped) await reader.cancel();
}
