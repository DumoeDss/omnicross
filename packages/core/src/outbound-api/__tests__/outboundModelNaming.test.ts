/**
 * Tests for the model-name-visibility surfaces (`modelNaming.realNames`):
 * the Codex-native `GET /v1/codex-model-catalog` route + the real-names mode of
 * both `GET /v1/models` shapes.
 *
 * Drives the REAL `handleOutboundRequest` (same harness discipline as
 * outboundAnthropicModels.test — no dispatch mock; the discovery branches never
 * dispatch), asserting: the catalog route is OFF-neutral (`{ models: [] }`),
 * real-names enumeration mirrors the alias-mode rules minus exact-map sources
 * (passthrough + wildcard catalogs + wildcard targets + kind refs), provider-row
 * metadata enrichment over the canonical registry, the Anthropic envelope
 * parity, and the OpenAI-shape pins.
 *
 * @module outbound-api/__tests__/outboundModelNaming.test
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { handleOutboundRequest, isCodexModelCatalogRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

function makeReq(opts: { method?: string; url?: string }): http.IncomingMessage {
  const r = Readable.from([]) as unknown as http.IncomingMessage;
  r.method = opts.method ?? 'GET';
  r.url = opts.url ?? '/v1/codex-model-catalog';
  r.headers = { authorization: 'Bearer any' };
  r.httpVersion = '1.1';
  (r as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  return r;
}

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

const enabledRow: OutboundKeyDbRow = {
  id: 'oak_1',
  name: 'k',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
};

/** A BYO provider row with curated models + per-model metadata. */
const PROVIDER = {
  id: 'deepseek',
  name: 'DeepSeek',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  modelConfigs: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      contextLength: 131_072,
      thinkingLevels: ['low', 'high'],
      enabled: true,
    },
  ],
  enabled: true,
};

function mkDeps(provider: Record<string, unknown> = PROVIDER): OutboundApiDeps {
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => enabledRow,
    outboundApiKeysCreate: async () => enabledRow,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetUpstream: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
  return {
    db,
    llmConfig: { getProvider: async () => provider } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: { getRouteMap: () => new ProviderProxyRouteMap() } as unknown,
    proxyDeps: { llmConfig: { getProvider: async () => provider }, apiKeyPool: null } as unknown,
  } as unknown as OutboundApiDeps;
}

function binding(over: Partial<GatewayBinding>): GatewayBinding {
  return {
    id: 'b1',
    name: 'route',
    enabled: true,
    endpoint: 'messages',
    target: { kind: 'provider', providerId: 'deepseek' },
    fallback: 'fail',
    ...over,
  };
}

/** A wildcard-mapping route (`*` → deepseek-flash) + an exact alias route. */
const WILDCARD_BINDINGS: GatewayBinding[] = [
  binding({
    id: 'b-wild',
    modelMappings: [{ source: '*', target: 'deepseek,deepseek-flash' }],
  }),
  binding({
    id: 'b-exact',
    modelMappings: [{ source: 'gpt-6-astra', target: 'deepseek,deepseek-v4-pro' }],
  }),
];

async function call(opts: {
  url?: string;
  bindings?: GatewayBinding[];
  modelNaming?: { realNames?: boolean };
  anthropic?: Record<string, unknown>;
}): Promise<MockRes> {
  const res = new MockRes();
  await handleOutboundRequest(
    makeReq({ url: opts.url }),
    res as unknown as http.ServerResponse,
    mkDeps(),
    {
      endpoints: [],
      bindings: opts.bindings ?? WILDCARD_BINDINGS,
      ...(opts.anthropic ? { anthropic: opts.anthropic } : {}),
      ...(opts.modelNaming ? { modelNaming: opts.modelNaming } : {}),
    },
    new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    new OutboundConcurrencyGate(),
  );
  return res;
}

describe('isCodexModelCatalogRequest', () => {
  it('matches the exact path with query + trailing-slash tolerance, never /v1/models', () => {
    expect(isCodexModelCatalogRequest('/v1/codex-model-catalog')).toBe(true);
    expect(isCodexModelCatalogRequest('/v1/codex-model-catalog?client_version=0.62.0')).toBe(true);
    expect(isCodexModelCatalogRequest('/v1/codex-model-catalog/')).toBe(true);
    expect(isCodexModelCatalogRequest('/v1/models')).toBe(false);
    expect(isCodexModelCatalogRequest(undefined)).toBe(false);
  });
});

describe('GET /v1/codex-model-catalog', () => {
  it('realNames off (and absent) serves the frozen empty catalog — picker merge is a no-op', async () => {
    for (const modelNaming of [undefined, { realNames: false }]) {
      const res = await call({ url: '/v1/codex-model-catalog', modelNaming });
      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(res.body)).toEqual({ models: [] });
    }
  });

  it('realNames on serves the name-addressable real ids with provider metadata', async () => {
    const res = await call({
      url: '/v1/codex-model-catalog',
      modelNaming: { realNames: true },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      models: Array<Record<string, unknown>>;
    };
    // Wildcard route contributes the target catalog (both provider models) +
    // the wildcard's own target id; the exact-map target is NOT name-addressable.
    const slugs = json.models.map((m) => m['slug']);
    expect(slugs).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const flash = json.models[0];
    expect(flash['display_name']).toBe('DeepSeek Flash');
    expect(flash['context_window']).toBe(131_072);
    expect(flash['supported_reasoning_levels']).toEqual([
      { effort: 'low', description: expect.any(String) },
      { effort: 'high', description: expect.any(String) },
    ]);
    // No ModelRef provider halves cross the wire.
    expect(res.body).not.toContain('deepseek,');
  });

  it('kind-mapped routes advertise their configured target refs (same ids the alias mode lists)', async () => {
    const res = await call({
      url: '/v1/codex-model-catalog',
      modelNaming: { realNames: true },
      bindings: [binding({ modelMap: { fable: 'deepseek,deepseek-flash', opus: '' } })],
    });
    const json = JSON.parse(res.body) as { models: Array<{ slug: string }> };
    expect(json.models.map((m) => m.slug)).toEqual(['deepseek-flash']);
  });

  it('a key scoped to zero endpoints is rejected 403', async () => {
    const res = new MockRes();
    await handleOutboundRequest(
      makeReq({ url: '/v1/codex-model-catalog' }),
      res as unknown as http.ServerResponse,
      {
        ...mkDeps(),
        db: {
          ...mkDeps().db,
          outboundApiKeysGetByHash: async () => ({
            ...enabledRow,
            kind: 'integration',
            allowedEndpoints: [],
          }),
        },
      } as unknown as OutboundApiDeps,
      { endpoints: [], bindings: WILDCARD_BINDINGS, modelNaming: { realNames: true } },
      new OutboundRateLimiter(),
      new UserMessageSerialQueue(),
      new OutboundConcurrencyGate(),
    );
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /v1/models — realNames mode', () => {
  it('Anthropic shape lists real ids with row display names (envelope parity with alias mode)', async () => {
    const res = await call({
      url: '/v1/models',
      modelNaming: { realNames: true },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      data: Array<{ id: string; display_name?: string }>;
      first_id: string | null;
      last_id: string | null;
      has_more: boolean;
    };
    expect(json.data.map((d) => d.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(json.data[0].display_name).toBe('DeepSeek Flash');
    expect(json.has_more).toBe(false);
    expect(json.first_id).toBe('deepseek-flash');
    expect(json.last_id).toBe('deepseek-v4-pro');
  });

  it('OpenAI shape (forced) lists real ids in the openai envelope', async () => {
    const res = await call({
      url: '/v1/models',
      modelNaming: { realNames: true },
      anthropic: { modelsShape: 'openai' },
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(json.object).toBe('list');
    expect(json.data.map((d) => d.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    for (const entry of json.data) {
      expect(entry.object).toBe('model');
      expect(entry.owned_by).toBe('omnicross');
    }
  });

  it('realNames off keeps the alias-mode list byte-for-byte (sources advertised)', async () => {
    const res = await call({ url: '/v1/models' });
    const json = JSON.parse(res.body) as { data: Array<{ id: string }> };
    // Alias mode: wildcard target catalog + wildcard target id + exact sources.
    expect(json.data.map((d) => d.id).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'gpt-6-astra',
    ]);
  });
});
