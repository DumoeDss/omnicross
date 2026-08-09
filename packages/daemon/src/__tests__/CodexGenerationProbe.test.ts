import { describe, expect, it } from 'vitest';

import { readCodexGenerationProbeStream } from '../probe/CodexGenerationProbe';

function fragmentedResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('CodexGenerationProbe SSE validation', () => {
  it('accepts a fragmented terminal response only after real output text arrives', async () => {
    const response = fragmentedResponse([
      'data: {"type":"response.output_',
      'text.delta","delta":"PO"}\r\n\r\n',
      'data: {"type":"response.output_text.delta","delta":"NG"}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ]);

    await expect(readCodexGenerationProbeStream(response)).resolves.toEqual({
      completed: true,
      outputChars: 4,
    });
  });

  it('accepts text carried only by the completed response object', async () => {
    const response = fragmentedResponse([
      'data: {"type":"response.completed","response":{"status":"completed","output":[',
      '{"type":"message","content":[{"type":"output_text","text":"PONG"}]}]}}\n\n',
    ]);

    await expect(readCodexGenerationProbeStream(response)).resolves.toEqual({
      completed: true,
      outputChars: 4,
    });
  });

  it('rejects a completed event without assistant output', async () => {
    const response = fragmentedResponse([
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ]);

    await expect(readCodexGenerationProbeStream(response)).resolves.toEqual({
      completed: false,
      outputChars: 0,
    });
  });
});
