import { describe, expect, it, vi } from 'vitest';

import { startChatGptWebBridge } from '../bridge/server';
import type { BridgeEvent } from '../bridge/types';

describe('ChatGPT Web HTTP protocol', () => {
  it('returns function calls to non-streaming clients without launching a browser', async () => {
    const bridge = await startChatGptWebBridge();
    vi.spyOn(bridge.worker, 'runRequest').mockImplementation(async function* (): AsyncGenerator<BridgeEvent> {
      yield { type: 'tool_call_start', id: 'call_1', name: 'shell' };
      yield { type: 'tool_call_delta', arguments: '{"command":"pwd"}' };
      yield { type: 'tool_call_end' };
      yield { type: 'done' };
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'chatgpt-web/pro', input: 'where am I?', stream: false }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'completed', output: [
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"pwd"}' },
      ] });
    } finally {
      await bridge.stop();
    }
  });

  it.each(['incomplete', 'eof'] as const)('refuses a %s compaction instead of returning a successful replacement history', async (terminal) => {
    const bridge = await startChatGptWebBridge();
    vi.spyOn(bridge.worker, 'runRequest').mockImplementation(async function* (): AsyncGenerator<BridgeEvent> {
      yield { type: 'text_delta', text: 'truncated checkpoint' };
      if (terminal === 'incomplete') yield { type: 'incomplete', reason: 'upstream_stall_timeout' };
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/v1/responses/compact`, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'chatgpt-web/pro', input: 'history' }),
      });
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.output).toBeUndefined();
    } finally {
      await bridge.stop();
    }
  });

  it('cancels the browser turn when the response client disconnects after posting its body', async () => {
    const bridge = await startChatGptWebBridge();
    const aborted = Promise.withResolvers<void>();
    vi.spyOn(bridge.worker, 'runRequest').mockImplementation(async function* (_parsed, signal): AsyncGenerator<BridgeEvent> {
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      yield { type: 'text_delta', text: 'started' };
      await aborted.promise;
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model: 'chatgpt-web/pro', input: 'hello', stream: true }),
      });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await aborted.promise;
      expect(bridge.worker.runRequest).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });
});
