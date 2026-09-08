/**
 * ProviderProxy chat-inline-images e2e (multi-provider-image-generation
 * group 5) — session image output through the REAL ingress + transformer
 * chain + relay (no mocked executeProviderCall), against a real `node:http`
 * mock Gemini upstream:
 *
 *   1. OpenAI-chat BYO gemini, non-stream: upstream inlineData → client
 *      `message.images` (data URL) + text content (the identity decode + relay
 *      passes the unified images field straight through).
 *   2. OpenAI-chat BYO gemini, streaming: upstream image chunk → client
 *      `delta.images` SSE chunk.
 *   3. Request side: the encoded upstream body carries
 *      `generationConfig.responseModalities: ['TEXT','IMAGE']` for an image
 *      model (buildRequestBody injection riding the real chain).
 *   4. Anthropic /v1/messages BYO gemini: images are DROPPED at the Anthropic
 *      face (text-only content blocks, no base64 anywhere in the body) and the
 *      drop is COUNTED (observable counter) — the honest boundary.
 *
 * @module provider-proxy/__tests__/ProviderProxy.chatInlineImages.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import {
  __resetAnthropicDroppedImageCountForTests,
  anthropicDroppedImageCount,
} from '../../transformer/transformers/utils/anthropicImageDrop';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../types';

// ── Mock Gemini upstream (image-bearing JSON + SSE) ──────────────────────────

const IMAGE_PNG_B64 = 'aVNBR1dBUkU=';

const GEMINI_IMAGE_JSON = {
  responseId: 'img-e2e',
  modelVersion: 'gemini-2.5-flash-image',
  candidates: [
    {
      content: {
        parts: [
          { text: 'Here is your cat' },
          { inlineData: { mimeType: 'image/png', data: IMAGE_PNG_B64 } },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 42, totalTokenCount: 47 },
};

const GEMINI_IMAGE_SSE = [
  `data: ${JSON.stringify({
    responseId: 'img-e2e',
    modelVersion: 'gemini-2.5-flash-image',
    candidates: [
      {
        content: { parts: [{ text: 'Here' }, { inlineData: { mimeType: 'image/png', data: IMAGE_PNG_B64 } }] },
      },
    ],
  })}`,
  '',
  `data: ${JSON.stringify({
    responseId: 'img-e2e',
    modelVersion: 'gemini-2.5-flash-image',
    candidates: [
      { content: { parts: [{ text: ' is your cat' }] }, finishReason: 'STOP' },
    ],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 42, totalTokenCount: 47 },
  })}`,
  '',
].join('\n');

interface MockUpstream {
  server: Server;
  port: number;
  lastBody: string | undefined;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    lastBody: undefined,
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.lastBody = body;
      const url = req.url ?? '';
      if (url.includes(':streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(GEMINI_IMAGE_SSE);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(GEMINI_IMAGE_JSON));
    });
  });
  state.server = server;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── LLM-config stub (real GeminiTransformer as the provider chain) ──────────

const PROVIDER_KEY = 'sk-byo-gemini-key';

function makeLlmConfig(upstreamBase: string): ProviderConfigSource {
  const gemini: Transformer = new GeminiTransformer();
  return {
    getProvider: vi.fn(async () => ({
      id: 'gemini-prov',
      name: 'gemini',
      apiFormat: 'gemini',
      api_base_url: upstreamBase,
      api_key: PROVIDER_KEY,
      models: ['gemini-2.5-flash-image'],
      enabled: true,
    })),
    resolveTransformerChain: vi.fn(async () => ({ providerTransformers: [], modelTransformers: [] })),
    getMainTransformer: vi.fn(async () => gemini),
    getTransformerService: () => ({ getTransformer: () => undefined }),
  } as unknown as ProviderConfigSource;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('ProviderProxy chat-inline-images (BYO gemini line)', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;

  async function startProxy(): Promise<void> {
    const llmConfig = makeLlmConfig(`http://127.0.0.1:${upstream.port}`);
    const deps: ProviderProxyDeps = { llmConfig };
    proxy = new ProviderProxy(deps);
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    __resetAnthropicDroppedImageCountForTests();
    upstream = await startMockUpstream();
  });

  afterEach(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
    setSubscriptionRegistryForOutbound(null);
    __resetAnthropicDroppedImageCountForTests();
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function route(ingressFormat: 'openai-chat' | 'anthropic-messages'): RouteContext {
    return {
      sessionId: 'sess-inline-images',
      targetProviderFormat: 'transform',
      model: 'gemini-2.5-flash-image',
      ingressFormat,
      authMode: 'byo',
      providerId: 'gemini-prov',
    };
  }

  // 1 — OpenAI-chat non-stream: message.images passes through end-to-end.
  it('openai-chat non-stream → upstream inlineData → message.images + text', async () => {
    await startProxy();
    const token = proxy.addRoute(route('openai-chat'));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image',
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; images?: string[] };
      }>;
    };
    expect(json.choices?.[0]?.message?.content).toBe('Here is your cat');
    expect(json.choices?.[0]?.message?.images).toEqual([
      `data:image/png;base64,${IMAGE_PNG_B64}`,
    ]);
  });

  // 3 — Request side: the real chain injected responseModalities upstream.
  it('upstream request body carries responseModalities for the image model', async () => {
    await startProxy();
    const token = proxy.addRoute(route('openai-chat'));
    await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image',
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });

    const sent = JSON.parse(upstream.lastBody ?? '{}') as {
      generationConfig?: { responseModalities?: string[] };
    };
    expect(sent.generationConfig?.responseModalities).toEqual(['TEXT', 'IMAGE']);
  });

  // 2 — OpenAI-chat streaming: delta.images chunk reaches the client SSE.
  it('openai-chat stream → upstream image chunk → delta.images in client SSE', async () => {
    await startProxy();
    const token = proxy.addRoute(route('openai-chat'));
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image',
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"content":"Here"');
    expect(text).toContain('"images"');
    expect(text).toContain(`data:image/png;base64,${IMAGE_PNG_B64}`);
  });

  // 4 — Anthropic face: honest drop + bounded count (non-stream).
  it('anthropic non-stream → images dropped, text kept, no base64, counted', async () => {
    await startProxy();
    const token = proxy.addRoute(route('anthropic-messages'));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });

    expect(res.status).toBe(200);
    const raw = await res.text();
    const json = JSON.parse(raw) as {
      type?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(json.type).toBe('message');
    // Text-only blocks — no image block was fabricated, no base64 anywhere.
    expect(json.content).toEqual([{ type: 'text', text: 'Here is your cat' }]);
    expect(raw).not.toContain('data:image');
    expect(raw).not.toContain(IMAGE_PNG_B64);
    // The drop was counted.
    expect(anthropicDroppedImageCount).toBe(1);
  });

  // 4b — Anthropic face, streaming.
  it('anthropic stream → image deltas dropped, text deltas flow, counted', async () => {
    await startProxy();
    const token = proxy.addRoute(route('anthropic-messages'));
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify({
        model: 'gemini-2.5-flash-image',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('Here');
    expect(text).toContain(' is your cat');
    expect(text).not.toContain('data:image');
    expect(text).not.toContain(IMAGE_PNG_B64);
    expect(anthropicDroppedImageCount).toBe(1);
  });
});
