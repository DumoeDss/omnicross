/**
 * Mock-based unit test for the `Logger` port (omnicross Phase 0b, task 5.2).
 *
 * Injects a mock `Logger` into the serving-core `logToolFormat` helper and
 * asserts the core logs through the port (`warn`/`info`) with NO reliance on the
 * concrete host `LoggerService`.
 */

import { describe, expect, it, vi } from 'vitest';

import { logToolFormat } from '../../completion/ToolExecutor';
import type { OpenAITool } from '../../tool-types';
import type { Logger } from '../logger';

function makeMockLogger() {
  const mock = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // The plain vi.fn() bag structurally satisfies the `Logger` port; cast so the
  // core consumer receives it as the port (never the host `LoggerService`).
  return { mock, logger: mock as unknown as Logger };
}

describe('Logger port — mock injection (task 5.2)', () => {
  it('the core logs an empty-tools warning through the port', () => {
    const { mock, logger } = makeMockLogger();

    logToolFormat([], logger);

    expect(mock.warn).toHaveBeenCalledTimes(1);
    expect(mock.warn).toHaveBeenCalledWith('No tools provided');
    expect(mock.info).not.toHaveBeenCalled();
  });

  it('the core logs the OpenAI tool summary via logger.info(message, meta)', () => {
    const { mock, logger } = makeMockLogger();
    const tools: OpenAITool[] = [
      {
        type: 'function',
        function: { name: 'search', description: 'find things', parameters: {} },
      },
    ];

    logToolFormat(tools, logger);

    expect(mock.info).toHaveBeenCalledTimes(1);
    const [message, meta] = mock.info.mock.calls[0];
    expect(message).toBe('Tools configured (OpenAI format)');
    expect(meta).toMatchObject({ count: 1, tools: ['search'] });
    expect(mock.warn).not.toHaveBeenCalled();
  });
});
