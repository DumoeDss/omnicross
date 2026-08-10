/**
 * Codex server-overload detection tests.
 *
 * The predicate mirrors Codex CLI's own classifier (`codex-api/src/sse/
 * responses.rs:669`): a `response.failed` SSE event whose `response.error.code`
 * is `server_is_overloaded` or `slow_down`. Delivered INSIDE a 200 stream, which
 * is why the route-activity status layer never sees it.
 */
import { describe, expect, it } from 'vitest';

import { isCodexServerOverloadEvent } from '../openaiResponsesIngress';

describe('isCodexServerOverloadEvent', () => {
  it('matches response.failed with either overload code', () => {
    expect(
      isCodexServerOverloadEvent({
        type: 'response.failed',
        response: { error: { code: 'server_is_overloaded', message: 'capacity' } },
      }),
    ).toBe(true);
    expect(
      isCodexServerOverloadEvent({
        type: 'response.failed',
        response: { error: { code: 'slow_down' } },
      }),
    ).toBe(true);
  });

  it('rejects non-overload events and shapes', () => {
    // Wrong type entirely.
    expect(isCodexServerOverloadEvent({ type: 'response.completed', response: { usage: {} } })).toBe(false);
    expect(
      isCodexServerOverloadEvent({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ).toBe(false);
    // response.failed but a non-overload code (quota / invalid prompt stay distinct).
    expect(
      isCodexServerOverloadEvent({ type: 'response.failed', response: { error: { code: 'invalid_prompt' } } }),
    ).toBe(false);
    // Missing error / malformed.
    expect(isCodexServerOverloadEvent({ type: 'response.failed' })).toBe(false);
    expect(isCodexServerOverloadEvent({ type: 'response.failed', response: {} })).toBe(false);
    expect(isCodexServerOverloadEvent({})).toBe(false);
  });
});
