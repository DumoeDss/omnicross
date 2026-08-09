/**
 * retryAroundCodexUsageLimit tests — the loop's body discipline and control
 * flow: a usage-limit wall is marked + retried on another account; a non-wall
 * error is rebuilt and relayed verbatim; a success is left untouched; the retry
 * cap bounds tail latency. The attempt runner is injected so the full pipeline
 * is not required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetSharedAccountHealthForTests, getSharedAccountHealth } from '../../../pipeline/SubscriptionAccountHealth';
import type { ResponsesCallPlan } from '../openaiResponsesIngress';
import { retryAroundCodexUsageLimit } from '../openaiResponsesIngress';

const PLAN = { proxyProviderId: 'codex' } as unknown as ResponsesCallPlan;
const BODY = { model: 'gpt-5' };

const WALL_BODY = JSON.stringify({
  error: {
    message:
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 16th, 2026 3:12 PM.",
  },
});

function wallResult(accountId: string, status = 429): { response: Response; rawStatus: number; accountId: string } {
  return { response: new Response(WALL_BODY, { status, headers: { 'content-type': 'application/json' } }), rawStatus: status, accountId };
}

function errorResult(accountId: string, body: string, status = 500): { response: Response; rawStatus: number; accountId: string } {
  return { response: new Response(body, { status, headers: { 'content-type': 'application/json' } }), rawStatus: status, accountId };
}

function successResult(accountId: string): { response: Response; rawStatus: number; accountId: string } {
  return { response: new Response('{"id":"resp_1","output":[]}', { status: 200, headers: { 'content-type': 'application/json' } }), rawStatus: 200, accountId };
}

beforeEach(() => __resetSharedAccountHealthForTests());
afterEach(() => __resetSharedAccountHealthForTests());

describe('retryAroundCodexUsageLimit', () => {
  it('marks the wall-hit account and returns the successful retry', async () => {
    const runAttempt = vi.fn(async () => successResult('B'));
    const result = await retryAroundCodexUsageLimit(BODY, PLAN, wallResult('A'), runAttempt);

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(result.rawStatus).toBe(200); // the retry's success, not the wall
    expect(result.accountId).toBe('B');
    // A is marked quota-exhausted; the successful B is healthy.
    expect(getSharedAccountHealth().getStatus('codex', 'A').state).toBe('quota_exhausted');
    expect(getSharedAccountHealth().getStatus('codex', 'B').state).toBe('healthy');
  });

  it('leaves a non-codex/non-error first result untouched (no body read)', async () => {
    const runAttempt = vi.fn();
    // A success first result → short-circuit, no inspection, no retry.
    const first = successResult('A');
    const result = await retryAroundCodexUsageLimit(BODY, PLAN, first, runAttempt);
    expect(result).toBe(first);
    expect(runAttempt).not.toHaveBeenCalled();
    // Body never consumed: still readable for the relay.
    expect(await first.response.clone().text()).toBe('{"id":"resp_1","output":[]}');
  });

  it('rebuilds a non-wall error body verbatim and does not retry', async () => {
    const runAttempt = vi.fn();
    const first = errorResult('A', '{"error":{"message":"internal server error"}}', 500);
    const result = await retryAroundCodexUsageLimit(BODY, PLAN, first, runAttempt);

    expect(runAttempt).not.toHaveBeenCalled();
    expect(result.rawStatus).toBe(500);
    expect(result.response.status).toBe(500);
    expect(await result.response.text()).toBe('{"error":{"message":"internal server error"}}');
    expect(getSharedAccountHealth().getStatus('codex', 'A').state).toBe('healthy');
  });

  it('caps consecutive wall hits at MAX_QUOTA_RETRIES, marking each inspected account', async () => {
    // Every retry is ALSO a wall on a new account: A (first), then B, C, D.
    let n = 0;
    const accounts = ['B', 'C', 'D'];
    const runAttempt = vi.fn(async () => wallResult(accounts[n++] ?? 'D'));
    const result = await retryAroundCodexUsageLimit(BODY, PLAN, wallResult('A'), runAttempt);

    // 3 retries (the cap), returning the 4th account's unread wall error.
    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(result.rawStatus).toBe(429);
    expect(result.accountId).toBe('D');
    // A, B, C were inspected + marked; D (the cap result) was NOT read/marked yet.
    expect(getSharedAccountHealth().getStatus('codex', 'A').state).toBe('quota_exhausted');
    expect(getSharedAccountHealth().getStatus('codex', 'B').state).toBe('quota_exhausted');
    expect(getSharedAccountHealth().getStatus('codex', 'C').state).toBe('quota_exhausted');
    expect(getSharedAccountHealth().getStatus('codex', 'D').state).toBe('healthy');
  });

  it('is a no-op for BYO / non-codex (no accountId, no retry)', async () => {
    const runAttempt = vi.fn();
    const byoPlan = { proxyProviderId: 'byo' } as unknown as ResponsesCallPlan;
    const first = { ...errorResult('A', '{"error":"x"}', 429), accountId: undefined };
    const result = await retryAroundCodexUsageLimit(BODY, byoPlan, first, runAttempt);
    expect(result).toBe(first);
    expect(runAttempt).not.toHaveBeenCalled();
  });
});
