/**
 * webhook-notifications: the wire path fires `key.quotaExceeded` alongside the
 * 402 and `key.quotaWarning` once per window when a key crosses the warn ratio.
 * Uses a captured emit sink (the daemon dispatcher's stand-in) to assert the
 * exact events + that the request outcome is unchanged.
 */
import { EventEmitter } from 'node:events';
import type http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebhookEvent } from '@omnicross/contracts/webhook-types';

import { __resetWebhookSinkForTests, setWebhookSink } from '../../pipeline/webhookEmit';
import { ProviderProxyRouteMap } from '../../provider-proxy/providerProxyRouteMap';
import { handleOutboundRequest } from '../outboundApiRouter';
import { OutboundConcurrencyGate } from '../outboundConcurrencyGate';
import { OutboundRateLimiter } from '../outboundRateLimiter';
import { __resetQuotaWarnGuardForTests } from '../quotaWarn';
import type { OutboundApiDeps, OutboundKeyDb, OutboundKeyDbRow } from '../types';
import { UserMessageSerialQueue } from '../userMessageSerialQueue';

class MockReq extends EventEmitter {
  method = 'POST';
  url = '/v1/chat/completions';
  headers: Record<string, string> = { authorization: 'Bearer any' };
  socket = { remoteAddress: '127.0.0.1', destroy: () => {} };
  httpVersion = '1.1';
  constructor(private readonly body: string) {
    super();
  }
  start(): void {
    process.nextTick(() => {
      if (this.body) this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
  }
}

class MockRes {
  statusCode = 0;
  body = '';
  headersSent = false;
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

const baseRow: OutboundKeyDbRow = {
  id: 'oak_self',
  name: 'k',
  keyHash: '',
  keyPrefix: 'sk-omnicross-',
  enabled: true,
  createdAt: Date.now(),
  lastUsedAt: null,
  revokedAt: null,
};

function makeDeps(row: OutboundKeyDbRow, tracker: OutboundApiDeps['keySpendTracker']): OutboundApiDeps {
  const db: OutboundKeyDb = {
    outboundApiKeysList: async () => [],
    outboundApiKeysGetByHash: async () => ({ ...row }),
    outboundApiKeysCreate: async () => row,
    outboundApiKeysRevoke: async () => true,
    outboundApiKeysTouchLastUsed: async () => true,
    outboundApiKeysSetEnabled: async () => true,
    outboundApiKeysSetMaxConcurrency: async () => true,
    outboundApiKeysSetPolicy: async () => true,
    outboundApiKeysMarkActivated: async () => true,
  };
  return {
    db,
    llmConfig: { getProvider: async () => ({ id: 'openai', api_key: 'sk-x', models: ['gpt-4o'] }) } as unknown as OutboundApiDeps['llmConfig'],
    providerProxy: { getRouteMap: () => new ProviderProxyRouteMap() } as unknown as OutboundApiDeps['providerProxy'],
    proxyDeps: { llmConfig: { getProvider: async () => null }, apiKeyPool: null } as unknown as OutboundApiDeps['proxyDeps'],
    keySpendTracker: tracker,
  };
}

const config = {
  endpoints: [{ endpoint: 'chat' as const, models: ['openai,gpt-4o'], useSubscription: false }],
};

async function run(row: OutboundKeyDbRow, tracker: OutboundApiDeps['keySpendTracker']): Promise<MockRes> {
  const req = new MockReq(JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }));
  const res = new MockRes();
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  req.start();
  await handleOutboundRequest(
    req as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
    makeDeps(row, tracker),
    config,
    new OutboundRateLimiter(),
    new UserMessageSerialQueue(),
    new OutboundConcurrencyGate(),
  );
  errSpy.mockRestore();
  return res;
}

afterEach(() => {
  __resetWebhookSinkForTests();
  __resetQuotaWarnGuardForTests();
});

describe('handleOutboundRequest — webhook quota events', () => {
  it('emits key.quotaExceeded alongside the 402 (secret-free: keyId not key material)', async () => {
    const seen: WebhookEvent[] = [];
    setWebhookSink((e) => seen.push(e));
    const tracker = {
      getSpend: async () => ({ dailyUsd: 12, dailyWindowStart: 0, weeklyUsd: 12, weeklyWindowStart: 0, totalUsd: 12 }),
    };
    const res = await run({ ...baseRow, dailyCostLimitUsd: 10 }, tracker);
    expect(res.statusCode).toBe(402);
    const exceeded = seen.filter((e) => e.kind === 'key.quotaExceeded');
    expect(exceeded).toEqual([
      { kind: 'key.quotaExceeded', at: expect.any(Number), keyId: 'oak_self', scope: 'daily', limitUsd: 10, spentUsd: 12 },
    ]);
    // secret-free: no key hash / prefix leaks into the payload.
    expect(JSON.stringify(exceeded)).not.toContain('sk-omnicross-');
  });

  it('emits key.quotaWarning once per window when crossing the ratio', async () => {
    const seen: WebhookEvent[] = [];
    setWebhookSink((e) => seen.push(e));
    const tracker = {
      getSpend: async () => ({ dailyUsd: 8, dailyWindowStart: 111, weeklyUsd: 0, weeklyWindowStart: 0, totalUsd: 8 }),
    };
    await run({ ...baseRow, dailyCostLimitUsd: 10 }, tracker);
    // Second request in the SAME window → deduped, no second warning.
    await run({ ...baseRow, dailyCostLimitUsd: 10 }, tracker);
    const warnings = seen.filter((e) => e.kind === 'key.quotaWarning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ keyId: 'oak_self', scope: 'daily', limitUsd: 10, spentUsd: 8 });
  });

  it('a policy-less key emits nothing', async () => {
    const seen: WebhookEvent[] = [];
    setWebhookSink((e) => seen.push(e));
    await run({ ...baseRow }, { getSpend: vi.fn() });
    expect(seen.filter((e) => e.kind.startsWith('key.'))).toHaveLength(0);
  });
});
