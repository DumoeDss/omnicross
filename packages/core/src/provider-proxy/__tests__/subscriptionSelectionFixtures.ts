import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderConfigSource } from '../../ports';
import type { Transformer } from '../../transformer';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import { ProviderProxy } from '../ProviderProxy';
import type { RouteContext, SubscriptionDispatchProfile } from '../types';
import { OpenAIOperationError } from '../../openai-operation';

export type SelectionIngress = 'chat' | 'responses' | 'anthropic';
export interface SelectionCase {
  ingress: SelectionIngress;
  alias: boolean;
  explicit: boolean;
  fallback?: boolean;
  refresh?: boolean;
  reverse?: boolean;
  rejectCapability?: boolean;
  retired?: { stage: 'primary' | 'account' | 'fallback'; model: 'deepseek-chat' | 'deepseek-reasoner' };
}

/** Real local HTTP on both sides of ProviderProxy; no credentials or mocked fetch. */
export async function runSubscriptionSelectionCase(options: SelectionCase): Promise<void> {
  const seen: Array<{ path: string; body: Record<string, unknown>; auth?: string; target?: string }> = [];
  const upstream = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const path = req.url ?? '';
      seen.push({ path, body, auth: req.headers.authorization, target: String(req.headers['x-selected-target'] ?? '') });
      res.setHeader('content-type', 'application/json');
      if (seen.length === 1 && (options.fallback || options.refresh)) {
        res.statusCode = options.refresh ? 401 : 429;
        res.end(JSON.stringify({ error: { message: 'local retry fixture' } }));
      } else if (path.endsWith('/messages')) {
        res.end(JSON.stringify({ id: 'msg-local', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      } else if (path.endsWith('/responses')) {
        res.end(JSON.stringify({ id: 'resp-local', object: 'response', status: 'completed', model: body.model,
          output: [{ id: 'msg-local', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
      } else {
        res.end(JSON.stringify({ id: 'chat-local', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const transformers: Record<string, Transformer> = {
    anthropic: new AnthropicTransformer(), openai: new OpenAITransformer(), 'openai-response': new OpenAIResponseTransformer(),
  };
  if (options.rejectCapability) {
    // Inject a typed encoder rejection to test the ingress error contract,
    // independently of each encoder's capability-detection rules.
    transformers['openai-response']!.transformRequestIn = async () => {
      throw new OpenAIOperationError({ status: 400, code: 'unsupported_capability', message: 'local encoder rejection' });
    };
  }
  const llmConfig = {
    getTransformerService: () => ({ getTransformer: (name: string) => transformers[name] }),
  } as unknown as ProviderConfigSource;
  const proxy = new ProviderProxy({ llmConfig });
  let authCalls = 0;
  let mapperCalls = 0;
  let refreshed = false;
  const primary = { modelId: options.retired?.stage === 'primary' ? options.retired.model : options.reverse ? 'logical-anthropic' : 'logical-response', temperature: 0.2, maxTokens: 90 };
  const alias = { modelId: options.retired?.stage === 'account' ? options.retired.model : options.reverse ? 'actual-response' : 'actual-anthropic', temperature: 0.4, maxTokens: 50 };
  const fallback = { modelId: options.retired?.stage === 'fallback' ? options.retired.model : 'fallback-chat', temperature: 0.8, maxTokens: 70 };
  const wireModel = (model: string): string => model === options.retired?.model ? 'deepseek-flash' : model;
  const wireNames = (model: string): string[] => model.endsWith('anthropic') ? ['anthropic']
    : model === 'deepseek-flash' || model === fallback.modelId ? ['openai'] : ['openai-response'];
  const profile: SubscriptionDispatchProfile = {
    providerId: 'opencodego', displayName: 'local selection regression', mode: 'transformer',
    authStrategy: {
      kind: 'static-bearer', providerId: 'opencodego',
      async applyHeaders(headers, hints) {
        authCalls++;
        assert.ok(hints?.resolvedModel === wireModel(primary.modelId) || hints?.resolvedModel === wireModel(fallback.modelId),
          'an account-selected model must never be remapped a second time');
        const actual = options.alias && hints?.resolvedModel === wireModel(primary.modelId) ? alias.modelId : undefined;
        hints?.reportSelection?.('local-account', false, actual);
        headers.Authorization = `Bearer local-account${refreshed ? '-refreshed' : ''}`;
        headers['x-selected-target'] = hints?.upstreamUrl ?? '';
      },
      async onUnauthorized() { refreshed = true; return true; },
      async describeStatus() { return { providerId: 'opencodego', ok: true }; },
    },
    resolveUpstreamUrl: (model) => `${base}/prefix/v1/${model.endsWith('anthropic') ? 'messages' : model === 'deepseek-flash' || model === fallback.modelId ? 'chat/completions' : 'responses'}`,
    providerTransformerNames: ['openai-response'],
    resolveProviderTransformerNames: wireNames,
    chatBridgeTransformerNames: wireNames,
    modelMapper: (model) => {
      mapperCalls++;
      assert.equal(model, 'sdk-placeholder');
      return { resolvedModel: primary.modelId, scenario: 'default', temperature: primary.temperature, maxTokens: primary.maxTokens };
    },
    nextFallback: options.fallback ? (_scenario, attempted) => attempted.includes(fallback.modelId) ? null : fallback : undefined,
  };
  const route: RouteContext = {
    sessionId: 'local-selection', targetProviderFormat: 'transform', model: 'sdk-placeholder',
    ingressFormat: options.ingress === 'chat' ? 'openai-chat' : options.ingress === 'responses' ? 'openai-responses' : 'anthropic-messages',
    authMode: 'subscription', providerId: 'opencodego', subscriptionProfile: profile,
    subscriptionConfig: { modelMap: { default: primary, background: alias }, fallbacks: { default: [fallback] } },
  };
  try {
    const port = await proxy.start();
    const token = proxy.addRoute(route);
    const tokenField = options.ingress === 'responses' ? 'max_output_tokens' : 'max_tokens';
    const request = {
      model: 'client-model',
      ...(options.ingress === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] }),
      ...(options.explicit ? { temperature: 0, [tokenField]: 12 } : {}),
    };
    const path = options.ingress === 'chat' ? 'chat/completions' : options.ingress === 'responses' ? 'responses' : 'messages';
    const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request),
    });
    const responseText = await response.text();
    if (options.rejectCapability) {
      assert.equal(response.status, 400, responseText);
      const errorBody = JSON.parse(responseText) as { type?: string; error?: { code?: string; type?: string } };
      assert.equal(errorBody.error?.code, 'unsupported_capability');
      if (options.ingress === 'anthropic') {
        assert.equal(errorBody.type, 'error');
        assert.equal(errorBody.error?.type, 'invalid_request_error');
      }
      assert.equal(seen.length, 0, 'typed capability failure never reaches upstream');
      assert.equal(authCalls, 1, 'typed capability failure never advances fallback');
      return;
    }
    assert.equal(response.status, 200, responseText);
    assert.ok(responseText.includes('ok'), responseText);
    assert.equal(mapperCalls, 1);
    assert.equal(authCalls, options.fallback || options.refresh ? 2 : 1, 'select exactly one account per HTTP attempt');
    assert.equal(seen.length, authCalls);
    for (let i = 0; i < seen.length; i++) {
      const expected = i > 0 && options.fallback ? fallback : options.alias ? alias : primary;
      const sent = seen[i]!;
      const expectedUrl = profile.resolveUpstreamUrl!(wireModel(expected.modelId));
      assert.equal(sent.path, new URL(expectedUrl).pathname);
      assert.equal(sent.target, expectedUrl, 'wire-sensitive auth sees the final URL');
      assert.equal(sent.auth, `Bearer local-account${i > 0 && options.refresh ? '-refreshed' : ''}`);
      assert.equal(sent.body.model, wireModel(expected.modelId));
      assert.equal(sent.body.temperature, options.explicit ? 0 : expected.temperature);
      const sentTokenField = sent.path.endsWith('/responses') ? 'max_output_tokens' : 'max_tokens';
      assert.equal(sent.body[sentTokenField], options.explicit ? 12 : expected.maxTokens);
      assert.ok(sent.path.endsWith('/responses') ? Array.isArray(sent.body.input) || typeof sent.body.input === 'string'
        : Array.isArray(sent.body.messages), 'body matches the selected wire');
    }
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}
