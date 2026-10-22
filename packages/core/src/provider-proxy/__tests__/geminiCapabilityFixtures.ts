import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderProxy } from '../ProviderProxy';
import type { ProviderConfigSource } from '../../ports';
import { OpenAITransformer } from '../../transformer/transformers/OpenAITransformer';

/** Exercise the real HTTP admission boundary, not only the transformer error. */
export async function runGeminiCapabilityRejections(): Promise<void> {
  let upstreamCalls = 0;
  const upstream = createServer((_req, res) => {
    upstreamCalls++;
    res.writeHead(500);
    res.end('Native-only request must never reach upstream');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const provider = {
    id: 'target', name: 'google-looking-name', apiFormat: 'openai',
    api_base_url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`,
    api_key: 'local-only', models: ['ordinary-model'], enabled: true,
  };
  const transformer = new OpenAITransformer();
  const llmConfig = {
    getProvider: async () => provider,
    resolveTransformerChain: async () => ({ providerTransformers: [], modelTransformers: [] }),
    getMainTransformer: async () => transformer,
    getTransformerService: () => ({ getTransformer: () => transformer }),
  } as unknown as ProviderConfigSource;
  const proxy = new ProviderProxy({ llmConfig });
  try {
    const port = await proxy.start();
    const token = proxy.addRoute({ sessionId: 'gemini-capability', targetProviderFormat: 'transform', ingressFormat: 'gemini-generatecontent', authMode: 'byo', providerId: provider.id, model: 'ordinary-model' });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ cachedContent: 'cachedContents/private' }, '$.cachedContent'],
      [{ tools: [{ googleSearch: {} }] }, '$.tools[0].googleSearch'],
      [{ tools: [{ codeExecution: {} }] }, '$.tools[0].codeExecution'],
      [{ toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }, '$.toolConfig.functionCallingConfig.mode'],
      [{ generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }, '$.generationConfig.responseModalities'],
      [{ generationConfig: { responseMimeType: 'image/png' } }, '$.generationConfig.responseMimeType'],
    ];
    for (const action of ['generateContent', 'streamGenerateContent?alt=sse']) {
      for (const [fields, path] of cases) {
        const response = await fetch(`http://127.0.0.1:${port}/v1beta/models/client-model:${action}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': token },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }], ...fields }),
        });
        const body: unknown = await response.json();
        assert.equal(response.status, 400, `${action} ${path}: ${JSON.stringify(body)}`);
        assert.ok(body && typeof body === 'object' && 'error' in body);
        const error = body.error;
        assert.ok(error && typeof error === 'object' && 'code' in error && 'message' in error);
        assert.equal(error.code, 'unsupported_capability');
        assert.ok(typeof error.message === 'string' && error.message.includes(path));
        assert.equal(upstreamCalls, 0, path);
      }
    }
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}
