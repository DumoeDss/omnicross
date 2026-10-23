import { describe, expect, it, vi } from 'vitest';

import { runChatGptWebTurn } from '../chatgpt/turn';
import { ChatGptWebBridgeWorker } from '../bridge/worker';
import { CHATGPT_WEB_MODEL_ROUTES } from '../bridge/models';
import { parseRequest } from '../bridge/parser';
import type { BridgeEvent } from '../bridge/types';

vi.mock('../chatgpt/turn', () => ({ runChatGptWebTurn: vi.fn() }));

describe('browser worker protocol output', () => {
  it('does not fabricate model reasoning from local capability warnings', async () => {
    const worker = new ChatGptWebBridgeWorker();
    const route = CHATGPT_WEB_MODEL_ROUTES.find((entry) => entry.slug === 'chatgpt-web/pro')!;
    vi.spyOn(worker, 'resolveRoute').mockResolvedValue(route);
    vi.mocked(runChatGptWebTurn).mockImplementation(async function* (): AsyncGenerator<BridgeEvent> {
      yield { type: 'thinking_delta', thinking: 'actual browser reasoning' };
      yield { type: 'text_delta', text: 'actual browser answer' };
      yield { type: 'done' };
    });
    const events: BridgeEvent[] = [];
    try {
      for await (const event of worker.runRequest(parseRequest({ model: route.slug, input: 'hello' }))) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: 'thinking_delta', thinking: 'actual browser reasoning' },
        { type: 'text_delta', text: 'actual browser answer' },
        { type: 'done' },
      ]);
    } finally {
      worker.connection.close();
    }
  });
});
