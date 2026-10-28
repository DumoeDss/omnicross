import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperationRegistry } from '../../../openai-operation';
import type { AuthApplyHints } from '../../../pipeline/AuthSource';
import type { ProviderConfigSource } from '../../../ports';
import { OpenAIResponseTransformer } from '../../../transformer/transformers/OpenAIResponseTransformer';
import { ProviderProxy } from '../../ProviderProxy';
import { registerResponsesCompactOperation } from '../responsesCompact';

describe('Codex subscription replay after a Chat provider turn', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await new Promise<void>((resolve, reject) => {
      upstream!.close((error) => error ? reject(error) : resolve());
    });
    proxy = undefined;
    upstream = undefined;
  });

  it.each(['create', 'compact'])('replays a converted GLM turn on %s without unresolved reasoning ids', async (operation) => {
    // Use the real producer of synthetic reasoning, rather than assuming its
    // output shape. The client retains this output when it switches upstreams.
    const converted = await new OpenAIResponseTransformer().transformResponseIn(new Response(JSON.stringify({
      id: 'chatcmpl-glm',
      object: 'chat.completion',
      model: 'glm-5.3',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Checking the file',
          reasoning_content: 'I should inspect the file first',
          tool_calls: [{
            id: 'call_read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"file.ts"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { headers: { 'Content-Type': 'application/json' } }));
    const { output } = await converted.json() as { output: Array<Record<string, unknown>> };
    const synthetic = output.find((item) => item.type === 'reasoning');
    expect(synthetic?.id).toMatch(/^rs_/);
    expect(synthetic?.encrypted_content).toBeUndefined();

    const input = [
      { type: 'message', role: 'user', content: 'Check file.ts' },
      ...output,
      { type: 'function_call_output', call_id: 'call_read', output: 'file contents' },
      { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'encrypted-reasoning' },
      { type: 'compaction', id: 'cmp_native', encrypted_content: 'encrypted-window' },
      { type: 'message', role: 'user', content: 'Continue' },
    ];
    const original = structuredClone(input);
    const received: Array<{ path: string; body: Record<string, unknown> }> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        received.push({ path: req.url ?? '', body });
        const unresolved = (body.input as Array<Record<string, unknown>>)
          .find((item) => item.type === 'reasoning' && !item.encrypted_content);
        if (unresolved) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Item with id '${unresolved.id}' not found. Items are not persisted when store is set to false.` } }));
        } else if (req.url?.endsWith('/compact')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ object: 'response.compaction', output: input.filter((item) => item.type === 'compaction') }));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end('data: {"type":"response.completed","response":{"id":"resp_replayed","status":"completed","output":[]}}\n\n');
        }
      });
    });
    const port = await new Promise<number>((resolve) => upstream!.listen(0, '127.0.0.1', () => {
      resolve((upstream!.address() as AddressInfo).port);
    }));
    const registry = new OpenAIOperationRegistry();
    registerResponsesCompactOperation(registry);
    proxy = new ProviderProxy({
      llmConfig: {
        getProvider: vi.fn(),
        resolveTransformerChain: vi.fn(),
        getMainTransformer: vi.fn(),
        getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
      } as unknown as ProviderConfigSource,
      openAIOperationRegistry: registry,
    });
    const proxyPort = await proxy.start();
    const token = proxy.addRoute({
      sessionId: 'switched-session',
      targetProviderFormat: 'openai-responses',
      model: 'gpt-native',
      ingressFormat: 'openai-responses',
      authMode: 'subscription',
      subscriptionProfile: {
        authStrategy: {
          providerId: 'codex',
          kind: 'oauth-bearer',
          async applyHeaders(headers: Record<string, string>, hints?: AuthApplyHints) {
            headers.Authorization = 'Bearer test-account';
            hints?.reportSelection?.('account-a', true);
          },
          async onUnauthorized() { return false; },
          async describeStatus() { return { providerId: 'codex', configured: true }; },
        } as never,
        providerTransformerNames: ['openai-response'],
        resolveUpstreamUrl: () => `http://127.0.0.1:${port}/backend-api/codex/responses`,
      },
    });
    const suffix = operation === 'compact' ? '/compact' : '';
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses${suffix}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'session-id': 'same-client-session' },
      body: JSON.stringify({ model: 'client', stream: true, input, store: false }),
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe(`/backend-api/codex/responses${suffix}`);
    expect(received[0].body.store).toBe(false);
    expect(received[0].body.input).toEqual(input.filter((item) => item !== synthetic));
    expect(input).toEqual(original);
  });
});
