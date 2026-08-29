/**
 * Integration tests for the translate-path content pre-pass + PDF handling,
 * the R8 codex overload bridge, and the R11 items
 * (`claude-api-transform-fidelity`): documents become extracted text on
 * translate routes and explicit-400 otherwise; search_result/container_upload
 * 400; same-format documents relay byte-verbatim; a codex overload event on a
 * subscription translate plan tallies `endpoint:'messages'` + amends the
 * route-activity row while the bytes relay unchanged; an in-band
 * `overloaded_error` on a subscription SAME-FORMAT relay cools the account
 * like a real 529 (other error types do not); usage events carry the new
 * `anthropic-messages-ingress` origin.
 *
 * @module provider-proxy/__tests__/anthropicTransformFidelity.test
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderConfigSource } from '../../ports';
import { setSubscriptionRegistryForOutbound } from '../../outbound-api/subscriptionRegistryPort';
import { getSharedAccountRouteActivity } from '../../pipeline/AccountRouteActivity';
import {
  getSharedAccountHealth,
  __resetSharedAccountHealthForTests,
} from '../../pipeline/SubscriptionAccountHealth';
import {
  getSharedOverloadCounter,
  __resetSharedOverloadCounterForTests,
} from '../../pipeline/ServerOverloadCounter';
import type { AuthStrategy } from '../../pipeline/SubscriptionAuthStrategy';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import type { Transformer } from '../../transformer/types';
import { ProviderProxy } from '../ProviderProxy';
import type {
  ProviderProxyDeps,
  RouteContext,
  SubscriptionDispatchProfile,
  UsageRecorderImport,
} from '../types';

// ── Mock upstream ─────────────────────────────────────────────────────────────

interface MockUpstream {
  server: Server;
  port: number;
  hits: number;
  paths: string[];
  lastBody: string | undefined;
  /** When set, every hit replies with this SSE text (200, event-stream). */
  sseScript: string | undefined;
  /** Paths (exact) that reply 503 — drives the fallback loop's advance. */
  failPaths: Set<string>;
  /** Bodies received per path (exact url → last body). */
  bodiesByPath: Map<string, string>;
}

function startMockUpstream(): Promise<MockUpstream> {
  const state: MockUpstream = {
    server: undefined as unknown as Server,
    port: 0,
    hits: 0,
    paths: [],
    lastBody: undefined,
    sseScript: undefined,
    failPaths: new Set(),
    bodiesByPath: new Map(),
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      const url = req.url ?? '';
      state.paths.push(url);
      state.lastBody = body;
      state.bodiesByPath.set(url, body);
      if (state.failPaths.has(url)) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'service unavailable' } }));
        return;
      }
      if (state.sseScript !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(state.sseScript);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          url.includes('/v1/messages')
            ? { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }
            : url.includes('/v1/responses')
              ? {
                  id: 'resp_mock',
                  object: 'response',
                  created_at: 1,
                  status: 'completed',
                  model: 'mock-model',
                  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
                  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                }
              : {
                  id: 'chatcmpl-mock',
                  object: 'chat.completion',
                  model: 'mock-model',
                  choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
                },
        ),
      );
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

function pdfBase64(textOps: string): string {
  const bytes = deflateSync(Buffer.from(textOps, 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + bytes.length + ' >>\nstream\n', 'latin1'),
    bytes,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]).toString('base64');
}

const TEXT_PDF = pdfBase64('BT /F1 12 Tf (Quarterly report text) Tj ET');
const SCAN_PDF = pdfBase64('/Image Do q Q');
const GARBAGE_PDF = pdfBase64(
  `BT (${String.fromCharCode(1, 2, 3, 4, 5, 6, 7)}) Tj ET`,
);

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── LLM-config stub ───────────────────────────────────────────────────────────

function makeLlmConfig(upstreamBase: string): ProviderConfigSource {
  const providers: Record<string, unknown> = {
    'openai-prov': {
      id: 'openai-prov', name: 'openai', apiFormat: 'openai',
      api_base_url: `${upstreamBase}/v1`, api_key: 'sk-byo', models: ['mock-model'], enabled: true,
    },
    'anthropic-prov': {
      id: 'anthropic-prov', name: 'anthropic', apiFormat: 'anthropic',
      api_base_url: upstreamBase, api_key: 'sk-byo', models: ['mock-model'], enabled: true,
    },
  };
  const transformers: Record<string, Transformer> = {
    openai: new OpenAITransformer(),
    'openai-response': new OpenAIResponseTransformer(),
  };
  return {
    getProvider: async (id: string) => (providers[id] as never) ?? null,
    resolveTransformerChain: async () => ({ providerTransformers: [], modelTransformers: [] }),
    getMainTransformer: async () => null,
    getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
  } as unknown as ProviderConfigSource;
}

function claudeStrategy(accountId: string, report: boolean): AuthStrategy {
  return {
    kind: 'pass-through',
    providerId: 'claude',
    async applyHeaders(headers, hints) {
      headers['Authorization'] = 'Bearer oauth';
      if (report) hints?.reportSelection?.(accountId, true);
    },
    async onUnauthorized() {
      return false;
    },
    async describeStatus() {
      return { providerId: 'claude', ok: true };
    },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Anthropic translate-path content + R8 + R11 fidelity', () => {
  let proxy: ProviderProxy;
  let baseUrl: string;
  let upstream: MockUpstream;
  let usageEvents: Array<{ engineOrigin?: string }>;

  async function startProxy(extra: Partial<ProviderProxyDeps> = {}): Promise<void> {
    usageEvents = [];
    proxy = new ProviderProxy({
      llmConfig: makeLlmConfig(`http://127.0.0.1:${upstream.port}`),
      usageRecorder: { record: (input) => usageEvents.push(input as { engineOrigin?: string }) } as UsageRecorderImport,
      ...extra,
    });
    const port = await proxy.start();
    baseUrl = `http://127.0.0.1:${port}`;
  }

  beforeEach(async () => {
    setSubscriptionRegistryForOutbound(null);
    __resetSharedOverloadCounterForTests();
    __resetSharedAccountHealthForTests();
    getSharedAccountRouteActivity().clear();
    upstream = await startMockUpstream();
  });

  afterEach(async () => {
    await proxy.stop();
    await stopServer(upstream.server);
    setSubscriptionRegistryForOutbound(null);
  });

  function bearer(token: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  /** BYO translate route (OpenAI-format provider → runPipeline decoder path). */
  function translateRoute(over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-t',
      targetProviderFormat: 'transform',
      model: 'mock-model',
      ingressFormat: 'anthropic-messages',
      authMode: 'byo',
      providerId: 'openai-prov',
      ...over,
    };
  }

  function sameFormatRoute(): RouteContext {
    return { ...translateRoute(), providerId: 'anthropic-prov', targetProviderFormat: 'anthropic' };
  }

  function bodyWithDocument(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      model: 'mock-model',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: TEXT_PDF } },
            { type: 'text', text: 'summarize the attached' },
          ],
        },
      ],
      ...over,
    });
  }

  async function post(url: string, token: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${url}`, { method: 'POST', headers: bearer(token), body });
  }

  // ── document blocks (§11.4 rows 3/4/5) ─────────────────────────────────────

  it('translate path: document text reaches the upstream as decoded content', async () => {
    await startProxy();
    const token = proxy.addRoute(translateRoute());
    const res = await post('/v1/messages', token, bodyWithDocument());

    expect(res.status).toBe(200);
    expect(upstream.hits).toBe(1);
    const sent = JSON.parse(upstream.lastBody ?? '{}') as { messages: Array<{ content: unknown }> };
    const flat = JSON.stringify(sent.messages);
    expect(flat).toContain('Quarterly report text');
    // The base64 payload is GONE (extracted, not forwarded).
    expect(flat).not.toContain(TEXT_PDF.slice(0, 40));
  });

  it('scan (no text layer) document → explicit 400 with the stable code, zero upstream calls', async () => {
    await startProxy();
    const token = proxy.addRoute(translateRoute());
    const res = await post(
      '/v1/messages',
      token,
      bodyWithDocument({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: SCAN_PDF } },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; message: string } };
    expect(json.error.type).toBe('invalid_request_error');
    expect(json.error.message).toContain('document_not_supported_on_route');
    expect(json.error.message).toContain('no-text-layer');
    expect(upstream.hits).toBe(0);
  });

  it('garbage-text document → 400 low-quality; tiny budget → 400 over-budget', async () => {
    await startProxy();
    const token = proxy.addRoute(translateRoute());
    const low = await post(
      '/v1/messages',
      token,
      bodyWithDocument({
        messages: [
          { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: GARBAGE_PDF } }] },
        ],
      }),
    );
    expect(low.status).toBe(400);
    expect(((await low.json()) as { error: { message: string } }).error.message).toContain('low-quality');

    const bigPdf = pdfBase64(`BT (${'x'.repeat(200_000)}) Tj ET`);
    const overToken = proxy.addRoute(
      translateRoute({ anthropicPdfTextExtractionBudgetMs: 1 }),
    );
    const over = await post(
      '/v1/messages',
      overToken,
      bodyWithDocument({
        messages: [
          { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bigPdf } }] },
        ],
      }),
    );
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: { message: string } }).error.message).toContain('over-budget');
    expect(upstream.hits).toBe(0);
  });

  it('search_result / container_upload blocks → explicit 400, zero upstream calls', async () => {
    await startProxy();
    const token = proxy.addRoute(translateRoute());
    for (const type of ['search_result', 'container_upload']) {
      const res = await post(
        '/v1/messages',
        token,
        JSON.stringify({
          model: 'mock-model',
          max_tokens: 64,
          messages: [{ role: 'user', content: [{ type, ...{} } as unknown as Record<string, unknown>] }],
        }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toContain('unsupported_content_block');
      expect(json.error.message).toContain(type);
    }
    expect(upstream.hits).toBe(0);
  });

  it('same-format path: document blocks relay byte-verbatim (moat pin)', async () => {
    await startProxy();
    const token = proxy.addRoute(sameFormatRoute());
    const raw = bodyWithDocument();
    const res = await post('/v1/messages', token, raw);
    expect(res.status).toBe(200);
    expect(upstream.lastBody).toBe(raw); // the base64 PDF went through untouched
  });

  it('same-format path: full R7 field set relays byte-verbatim (moat pin)', async () => {
    await startProxy();
    const token = proxy.addRoute(sameFormatRoute());
    const raw = JSON.stringify({
      model: 'mock-model',
      max_tokens: 64,
      stop_sequences: ['END'],
      top_p: 0.5,
      top_k: 40,
      metadata: { user_id: 'u1' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await post('/v1/messages', token, raw);
    expect(res.status).toBe(200);
    expect(upstream.lastBody).toBe(raw);
  });

  // ── R8: messages→codex overload bridge (AC-11) ─────────────────────────────

  function codexOverloadSse(): string {
    return [
      'event: response.created',
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}`,
      '',
      'event: response.failed',
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'server_is_overloaded', message: 'The server is overloaded' } },
      })}`,
      '',
      '',
    ].join('\n');
  }

  function codexTranslateProfile(upstreamUrl: string): SubscriptionDispatchProfile {
    return {
      providerId: 'codex',
      displayName: 'Codex',
      authStrategy: {
        kind: 'static-bearer',
        providerId: 'codex',
        async applyHeaders(headers, hints) {
          headers['Authorization'] = 'Bearer codex-key';
          // Real codex strategies report the selected account — the bridge's
          // counter key depends on it.
          hints?.reportSelection?.('acct-codex', true);
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'codex', ok: true };
        },
      },
      mode: 'transformer',
      resolveUpstreamUrl: () => upstreamUrl,
      providerTransformerNames: ['openai-response'],
    };
  }

  function codexRoute(profile: SubscriptionDispatchProfile, over: Partial<RouteContext> = {}): RouteContext {
    return {
      sessionId: 'sess-codex',
      targetProviderFormat: 'transform',
      model: 'gpt-5-codex',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'codex',
      subscriptionProfile: profile,
      ...over,
    };
  }

  it('200+SSE codex overload on a subscription TRANSLATE plan → endpoint:messages counter + row amended + bytes relayed', async () => {
    upstream.sseScript = codexOverloadSse();
    await startProxy();
    const url = `http://127.0.0.1:${upstream.port}/v1/responses`;
    const token = proxy.addRoute(codexRoute(codexTranslateProfile(url)));
    const res = await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'gpt-5-codex', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const text = await res.text();
    // The stream (whatever shape the chain produced) relayed to the client.
    expect(upstream.hits).toBe(1);
    const rows = getSharedOverloadCounter().list({ providerId: 'codex' });
    const messagesRow = rows.find((r) => r.endpoint === 'messages');
    expect(messagesRow?.count ?? 0).toBeGreaterThan(0);
    // The route-activity row for the 200 is annotated with the stream error.
    const activity = getSharedAccountRouteActivity().list({ endpoint: 'messages' });
    expect(activity.some((row) => row.streamError === 'server_overloaded')).toBe(true);
    // Relayed bytes unchanged — the observer is read-only; the client sees the
    // official in-band error event carrying the codex code.
    expect(text).toContain('server_is_overloaded');
  });

  it('a NON-overload failure code does not tally', async () => {
    upstream.sseScript = [
      'event: response.failed',
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'usage_limit_reached', message: 'quota' } },
      })}`,
      '',
      '',
    ].join('\n');
    await startProxy();
    const url = `http://127.0.0.1:${upstream.port}/v1/responses`;
    const token = proxy.addRoute(codexRoute(codexTranslateProfile(url)));
    await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'gpt-5-codex', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const rows = getSharedOverloadCounter().list({ providerId: 'codex' });
    expect(rows.find((r) => r.endpoint === 'messages')?.count ?? 0).toBe(0);
  });

  it('BYO translate plans never wire the detector (zero counter movement on overload-shaped errors)', async () => {
    upstream.sseScript = codexOverloadSse();
    await startProxy();
    const token = proxy.addRoute(translateRoute());
    await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'mock-model', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const rows = getSharedOverloadCounter().list({});
    expect(rows.filter((r) => r.endpoint === 'messages').reduce((n, r) => n + r.count, 0)).toBe(0);
  });

  // ── R11③: same-format in-band overloaded_error ─────────────────────────────

  function sameFormatProfile(upstreamUrl: string): SubscriptionDispatchProfile {
    return {
      providerId: 'claude',
      displayName: 'Claude',
      authStrategy: claudeStrategy('acct-inband', true),
      mode: 'pass-through',
      resolveUpstreamUrl: () => upstreamUrl,
      providerTransformerNames: ['anthropic'],
    };
  }

  it('in-band overloaded_error on a subscription SAME-FORMAT stream cools the account; bytes unchanged', async () => {
    const inbandError = [
      'event: message_start',
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 1 } } })}`,
      '',
      'event: error',
      `data: ${JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      })}`,
      '',
      '',
    ].join('\n');
    upstream.sseScript = inbandError;
    await startProxy();
    const token = proxy.addRoute({
      sessionId: 'sess-sf',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'claude',
      subscriptionProfile: sameFormatProfile(`http://127.0.0.1:${upstream.port}/v1/messages`),
    });
    const res = await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('overloaded_error');
    // The account is now in overload cooldown (529-equivalent) — bytes unchanged.
    expect(getSharedAccountHealth().isSchedulable('claude', 'acct-inband')).toBe(false);
  });

  it('in-band invalid_request_error does NOT cool the account', async () => {
    upstream.sseScript = [
      'event: error',
      `data: ${JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'bad' },
      })}`,
      '',
      '',
    ].join('\n');
    await startProxy();
    const token = proxy.addRoute({
      sessionId: 'sess-sf2',
      targetProviderFormat: 'transform',
      model: 'claude-sonnet-4-5',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'claude',
      subscriptionProfile: sameFormatProfile(`http://127.0.0.1:${upstream.port}/v1/messages`),
    });
    await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(getSharedAccountHealth().isSchedulable('claude', 'acct-inband')).toBe(true);
  });

  it('multiple overload events in ONE stream record exactly once (dedup pin, C-m2)', async () => {
    upstream.sseScript = [
      'event: response.failed',
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'server_is_overloaded', message: 'overloaded' } },
      })}`,
      '',
      'event: response.failed',
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { error: { code: 'slow_down', message: 'slow' } },
      })}`,
      '',
      '',
    ].join('\n');
    await startProxy();
    const url = `http://127.0.0.1:${upstream.port}/v1/responses`;
    const token = proxy.addRoute(codexRoute(codexTranslateProfile(url)));
    await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'gpt-5-codex', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const rows = getSharedOverloadCounter().list({ providerId: 'codex' });
    const messagesRow = rows.find((r) => r.endpoint === 'messages');
    expect(messagesRow?.count).toBe(1);
  });

  // ── C-M3: the pre-pass follows the per-ITERATION wire classification ──────

  function flipProfile(primary: string, fallbackModel: string): SubscriptionDispatchProfile {
    return {
      providerId: 'opencodego',
      displayName: 'OpenCodeGo',
      authStrategy: {
        kind: 'static-bearer',
        providerId: 'opencodego',
        async applyHeaders(headers) {
          headers['Authorization'] = 'Bearer oc-key';
        },
        async onUnauthorized() {
          return false;
        },
        async describeStatus() {
          return { providerId: 'opencodego', ok: true };
        },
      },
      mode: 'transformer',
      // go-mini resolves to the /v1/messages (same-format) upstream; anything
      // else to the /v1/responses (translate) upstream.
      resolveUpstreamUrl: (model: string) =>
        model === 'go-mini'
          ? `http://127.0.0.1:${upstream.port}/v1/messages`
          : `http://127.0.0.1:${upstream.port}/v1/responses`,
      providerTransformerNames: ['openai-response'],
      modelMapper: () => ({ resolvedModel: primary, scenario: 'long_context' }),
      nextFallback: (_scenario: string, attempted: readonly string[]) =>
        attempted.length === 1 ? { modelId: fallbackModel } : null,
    };
  }

  function flipRoute(profile: SubscriptionDispatchProfile): RouteContext {
    return {
      sessionId: 'sess-flip',
      targetProviderFormat: 'transform',
      model: 'any-model',
      ingressFormat: 'anthropic-messages',
      authMode: 'subscription',
      providerId: 'opencodego',
      subscriptionProfile: profile,
    };
  }

  it('sameFormat→translate flip: the fallback iteration preps its OWN body (document survives, not re-dropped)', async () => {
    upstream.failPaths.add(`/v1/messages`); // primary (go-mini, same-format) 503s
    await startProxy();
    const token = proxy.addRoute(flipRoute(flipProfile('go-mini', 'zen-a')));
    const res = await post('/v1/messages', token, bodyWithDocument());
    expect(res.status).toBe(200);
    expect(upstream.paths).toEqual(['/v1/messages', '/v1/responses']);
    // The TRANSLATE iteration's upstream received the EXTRACTED text (the
    // per-iteration pre-pass ran), never the base64 document.
    const translateBody = upstream.bodiesByPath.get('/v1/responses') ?? '';
    expect(translateBody).toContain('Quarterly report text');
    expect(translateBody).not.toContain(TEXT_PDF.slice(0, 40));
  });

  it('translate→sameFormat flip: the same-format iteration receives the ORIGINAL document bytes (moat)', async () => {
    upstream.failPaths.add(`/v1/responses`); // primary (zen-a, translate) 503s
    await startProxy();
    const token = proxy.addRoute(flipRoute(flipProfile('zen-a', 'go-mini')));
    const res = await post('/v1/messages', token, bodyWithDocument());
    expect(res.status).toBe(200);
    expect(upstream.paths).toEqual(['/v1/responses', '/v1/messages']);
    // The SAME-FORMAT iteration's body carries the document block UNMUTATED
    // (base64 intact — the translate clone never leaked into it) + its model.
    const sameFormatBody = upstream.bodiesByPath.get('/v1/messages') ?? '';
    const parsed = JSON.parse(sameFormatBody) as {
      model: string;
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(parsed.model).toBe('go-mini');
    expect(parsed.messages[0].content.some((b) => b.type === 'document')).toBe(true);
    expect(sameFormatBody).toContain(TEXT_PDF.slice(0, 40));
  });

  // ── R11①: engineOrigin ─────────────────────────────────────────────────────

  it('usage events on the messages path carry engineOrigin anthropic-messages-ingress', async () => {
    await startProxy();
    const token = proxy.addRoute(sameFormatRoute());
    const res = await post(
      '/v1/messages',
      token,
      JSON.stringify({ model: 'mock-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(usageEvents.length).toBeGreaterThan(0);
    for (const event of usageEvents) {
      expect(event.engineOrigin).toBe('anthropic-messages-ingress');
    }
  });
});
