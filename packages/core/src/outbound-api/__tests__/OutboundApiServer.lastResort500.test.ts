/**
 * Last-resort 500 pin for the `OutboundApiServer` catch site
 * (`claude-api-routing-errors`, task 4.3).
 *
 * `onRequest` wraps the shared `handleOutboundRequest()` pipeline in a
 * `.catch()` whose writer branches on the Anthropic-protocol mark (set at the
 * real `handleOutboundRequest` entry). These tests pin BOTH branches through
 * the REAL loopback listener with only the pipeline mocked (the queue-suite
 * pattern): a rejection AFTER the mark must answer with the official Anthropic
 * error shape, while an unmarked rejection (the chat path) keeps the legacy
 * `outbound_api_error` envelope byte-for-byte.
 *
 * @module outbound-api/__tests__/OutboundApiServer.lastResort500.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markAnthropicProtocolResponse } from '../../provider-proxy/ingress/anthropicErrorEnvelope';
import { classifyAnthropicMessagesPath } from '../../provider-proxy/ingress/anthropicPathMatch';
import { OutboundApiServer } from '../OutboundApiServer';
import { handleOutboundRequest } from '../outboundApiRouter';
import type { OutboundApiDeps } from '../types';

vi.mock('../outboundApiRouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../outboundApiRouter')>()),
  handleOutboundRequest: vi.fn(),
}));

// Minimal deps — the pipeline is mocked, so nothing on deps is ever touched.
const deps = {} as OutboundApiDeps;

let server: OutboundApiServer | null = null;
let baseUrl = '';

beforeEach(async () => {
  server = new OutboundApiServer(deps);
  // No startup gate on model config — an empty endpoint list binds fine, and
  // nothing routes anyway (the pipeline is mocked).
  await server.applyConfig({ enabled: true, networkBinding: false, endpoints: [], port: 0 });
  baseUrl = `http://127.0.0.1:${server.getStatus().port}`;
});

afterEach(async () => {
  await server?.stop();
  server = null;
});

/** Mirror the real `handleOutboundRequest` entry contract: mark `/v1/messages*`, then reject. */
function mockPipelineRejectsWith(err: Error): void {
  vi.mocked(handleOutboundRequest).mockImplementation(async (req, res) => {
    if (classifyAnthropicMessagesPath(req.url) !== null) markAnthropicProtocolResponse(res);
    throw err;
  });
}

describe('OutboundApiServer last-resort 500 (mark-aware)', () => {
  it('rejection after the Anthropic mark → 500 Anthropic api_error shape', async () => {
    mockPipelineRejectsWith(new Error('outbound exploded'));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'outbound exploded' },
    });
  });

  it('rejection on an unmarked (chat) path → 500 legacy outbound_api_error byte shape', async () => {
    mockPipelineRejectsWith(new Error('outbound exploded'));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(
      JSON.stringify({ error: { type: 'outbound_api_error', message: 'outbound exploded' } }),
    );
  });
});
