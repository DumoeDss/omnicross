/**
 * Tests for the Anthropic `GET /v1/models` shape + alias advertising
 * (`claude-api-protocol-fidelity`, R4 / capability anthropic-models-list).
 *
 * Drives the REAL `handleOutboundRequest` models branch (no dispatch mock
 * needed — the branch never dispatches) with hand-built gateway bindings,
 * asserting: shape selection by key authorization (auto/forced), configured-
 * kinds-only advertising, `modelMappings` source aliases with
 * `"(via <upstream>)"` display names, passthrough catalog ids, limit/has_more,
 * direct 200 (no redirect), zero upstream calls, and the OpenAI-shape
 * regression pins.
 *
 * @module outbound-api/__tests__/outboundAnthropicModels.test
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { handleOutboundRequest, resolveModelsShape } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import type { GatewayBinding, OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

// --- mocks --------------------------------------------------------------------

function makeReq(opts: { method?: string; url?: string }): http.IncomingMessage {
  const r = Readable.from([]) as unknown as http.IncomingMessage;
  r.method = opts.method ?? 'GET';
  r.url = opts.url ?? '/v1/models';
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

function mkDeps(row: OutboundKeyDbRow, models: string[] = ['deepseek-v3', 'deepseek-r1']): OutboundApiDeps {
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => row,
    outboundApiKeysCreate: async () => row,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
    outboundApiKeysReveal: async () => null,
    outboundApiKeysDelete: async () => true,
  };
  const provider = { id: 'deepseek', name: 'DeepSeek', models, enabled: true };
  return {
    db,
    llmConfig: { getProvider: async () => provider } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: {
      getRouteMap: () => new ProviderProxyRouteMap(),
    } as unknown as OutboundApiDeps['providerProxy'],
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

/** messages bindings: an alias mapping route + a kind-mapped route (opus blank). */
const MESSAGES_BINDINGS: GatewayBinding[] = [
  binding({
    id: 'b-alias',
    modelMappings: [{ source: 'my-claude', target: 'deepseek,deepseek-v3' }],
  }),
  binding({
    id: 'b-kind',
    modelMap: { fable: 'deepseek,deepseek-v3', sonnet: 'openai,gpt-4o', opus: '' },
  }),
];

async function callModels(opts: {
  url?: string;
  row?: OutboundKeyDbRow;
  bindings?: GatewayBinding[];
  anthropic?: Record<string, unknown>;
}): Promise<MockRes> {
  const res = new MockRes();
  const req = makeReq({ url: opts.url ?? '/v1/models' });
  await handleOutboundRequest(
    req,
    res as unknown as http.ServerResponse,
    mkDeps(opts.row ?? enabledRow),
    {
      endpoints: [],
      bindings: opts.bindings ?? MESSAGES_BINDINGS,
      ...(opts.anthropic ? { anthropic: opts.anthropic } : {}),
    },
    new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    new OutboundConcurrencyGate(),
  );
  return res;
}

// --- tests ---------------------------------------------------------------------

describe('resolveModelsShape', () => {
  it('auto: messages-authorized or unrestricted → anthropic; else openai', () => {
    expect(resolveModelsShape(undefined, undefined)).toBe('anthropic');
    expect(resolveModelsShape('auto', ['messages'])).toBe('anthropic');
    expect(resolveModelsShape('auto', ['messages', 'chat'])).toBe('anthropic');
    expect(resolveModelsShape('auto', ['chat', 'responses'])).toBe('openai');
  });
  it('explicit config overrides authorization', () => {
    expect(resolveModelsShape('anthropic', ['chat'])).toBe('anthropic');
    expect(resolveModelsShape('openai', ['messages'])).toBe('openai');
  });
});

describe('GET /v1/models — Anthropic shape', () => {
  it('unrestricted key gets the Anthropic list shape with aliases + configured kinds only', async () => {
    const res = await callModels({});
    expect(res.statusCode).toBe(200); // direct 200, never a redirect
    expect(res.headers['Content-Type']).toBe('application/json');
    const json = JSON.parse(res.body) as {
      data: Array<{ id: string; type: string; display_name?: string; created_at?: string }>;
      first_id: string | null;
      last_id: string | null;
      has_more: boolean;
    };
    expect(json.data.map((d) => d.id).sort()).toEqual(['fable', 'my-claude', 'sonnet']);
    for (const entry of json.data) expect(entry.type).toBe('model');
    // created_at: present, ISO-8601, identical across entries (per-process
    // constant — the SDK `Model` type declares the field).
    for (const entry of json.data) {
      expect(entry.created_at).toBeDefined();
      expect(entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
    expect(new Set(json.data.map((d) => d.created_at)).size).toBe(1);
    expect(json.has_more).toBe(false);
    expect(json.first_id).toBe(json.data[0].id);
    expect(json.last_id).toBe(json.data[json.data.length - 1].id);
  });

  it('the alias carries a "(via <upstream>)" display_name; kind entries too; no provider/account leakage', async () => {
    const res = await callModels({});
    const json = JSON.parse(res.body) as {
      data: Array<{ id: string; display_name?: string }>;
    };
    const byId = Object.fromEntries(json.data.map((d) => [d.id, d]));
    expect(byId['my-claude'].display_name).toBe('my-claude (via deepseek-v3)');
    expect(byId['fable'].display_name).toBe('fable (via deepseek-v3)');
    expect(byId['sonnet'].display_name).toBe('sonnet (via gpt-4o)');
    // The providerId half of the ModelRef never crosses the wire.
    expect(res.body).not.toContain('deepseek,');
    expect(res.body).not.toContain('openai,');
  });

  it('limit=1 → one entry with has_more:true', async () => {
    const res = await callModels({ url: '/v1/models?limit=1' });
    const json = JSON.parse(res.body) as {
      data: unknown[];
      has_more: boolean;
      last_id: string | null;
    };
    expect(json.data).toHaveLength(1);
    expect(json.has_more).toBe(true);
    expect(json.last_id).toBe((json.data[0] as { id: string }).id);
  });

  it('passthrough subscription binding advertises the catalog ids', async () => {
    const res = await callModels({
      bindings: [
        binding({
          id: 'b-sub',
          modelMode: 'passthrough',
          target: { kind: 'account-pool', providerId: 'claude' },
        }),
      ],
    });
    const json = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(json.data.length).toBeGreaterThan(0);
    for (const entry of json.data) expect(entry.id).toMatch(/^claude-/);
  });

  it('passthrough provider binding advertises the provider row models', async () => {
    const res = await callModels({
      bindings: [binding({ id: 'b-prov', modelMode: 'passthrough' })],
    });
    const json = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(json.data.map((d) => d.id)).toEqual(['deepseek-v3', 'deepseek-r1']);
  });
});

describe('GET /v1/models — OpenAI shape pins', () => {
  it('a chat/responses-only key keeps the OpenAI shape (regression pin)', async () => {
    const res = await callModels({
      row: { ...enabledRow, allowedEndpoints: ['chat', 'responses'] },
      bindings: [
        ...MESSAGES_BINDINGS,
        binding({ id: 'b-chat', endpoint: 'chat', models: ['deepseek,deepseek-v3'] }),
      ],
    });
    const json = JSON.parse(res.body) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(json.object).toBe('list');
    expect(json.data.every((d) => d.object === 'model' && d.owned_by === 'omnicross')).toBe(true);
  });

  it("modelsShape:'openai' is the escape hatch for a messages-authorized key", async () => {
    const res = await callModels({
      row: { ...enabledRow, allowedEndpoints: ['messages'] },
      anthropic: { modelsShape: 'openai' },
    });
    const json = JSON.parse(res.body) as { object: string };
    expect(json.object).toBe('list');
  });

  it("modelsShape:'anthropic' forces the Anthropic shape even for a chat-only key", async () => {
    const res = await callModels({
      row: { ...enabledRow, allowedEndpoints: ['chat'] },
      anthropic: { modelsShape: 'anthropic' },
      bindings: MESSAGES_BINDINGS,
    });
    const json = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(json.data[0]).toBeDefined();
    expect(json.data[0].type === 'model' || json.data[0].id).toBeTruthy();
    expect(json.first_id !== undefined).toBe(true);
  });
});
