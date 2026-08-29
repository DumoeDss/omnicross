/**
 * Last-resort 500 pin for the resident `ProviderProxy` catch site
 * (`claude-api-routing-errors`, task 4.3).
 *
 * `ProviderProxy.start()`'s request handler wraps the shared `routeRequest()`
 * dispatch in a `.catch()` whose writer is the mark-aware shared `writeError`.
 * These tests pin BOTH branches through the REAL loopback listener with only
 * the dispatch mocked (the queue-suite pattern): a rejection AFTER the
 * Anthropic-protocol mark (set at the real `routeRequest` entry, before token
 * auth) must answer with the official Anthropic error shape, while an
 * unmarked rejection (a non-Anthropic path, e.g. codex `/responses`) keeps the
 * legacy `provider_proxy_error` envelope byte-for-byte.
 *
 * @module provider-proxy/__tests__/ProviderProxy.lastResort500.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markAnthropicProtocolResponse } from '../ingress/anthropicErrorEnvelope';
import { classifyAnthropicMessagesPath } from '../ingress/anthropicPathMatch';
import { ProviderProxy } from '../ProviderProxy';
import { routeRequest } from '../providerProxyRouter';
import type { ProviderProxyDeps } from '../types';

vi.mock('../providerProxyRouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providerProxyRouter')>()),
  routeRequest: vi.fn(),
}));

// Minimal deps — the dispatch is mocked, so nothing on deps is ever touched.
const deps = {} as ProviderProxyDeps;

let proxy: ProviderProxy | null = null;
let baseUrl = '';

beforeEach(async () => {
  proxy = new ProviderProxy(deps);
  const port = await proxy.start();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await proxy?.stop();
  proxy = null;
});

/** Mirror the real `routeRequest` entry contract: mark `/v1/messages*`, then reject. */
function mockDispatchRejectsWith(err: Error): void {
  vi.mocked(routeRequest).mockImplementation(async (req, res) => {
    if (classifyAnthropicMessagesPath(req.url) !== null) markAnthropicProtocolResponse(res);
    throw err;
  });
}

describe('ProviderProxy last-resort 500 (mark-aware)', () => {
  it('rejection after the Anthropic mark → 500 Anthropic api_error shape', async () => {
    mockDispatchRejectsWith(new Error('route exploded'));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'route exploded' },
    });
  });

  it('rejection on an unmarked (non-Anthropic) path → 500 legacy provider_proxy_error byte shape', async () => {
    mockDispatchRejectsWith(new Error('route exploded'));
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hi' }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(
      JSON.stringify({ error: { type: 'provider_proxy_error', message: 'route exploded' } }),
    );
  });
});
