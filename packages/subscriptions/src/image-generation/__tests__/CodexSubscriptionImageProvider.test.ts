import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ImageCapabilityEvidenceLayer,
  ImageCapabilityValues,
  ImageGenerationErrorCode,
  ImageProviderEvent,
  NormalizedImageGenerateRequest,
} from '@omnicross/contracts/image-generation-types';
import type { ImageProviderContext } from '@omnicross/core/image-generation';
import {
  __resetUpstreamProxyForTests,
  setUpstreamProxyResolver,
} from '@omnicross/core/pipeline/upstreamFetch';
import {
  __resetUpstreamTraceForTests,
  REDACTED_BODY,
  setUpstreamTracePath,
} from '@omnicross/core/pipeline/upstreamTrace';

import type { AuthStrategy } from '../../auth';
import {
  createCodexSubscriptionImageProvider,
  type CodexSubscriptionImageProviderOptions,
} from '../CodexSubscriptionImageProvider';
import type { CodexImageCapabilityEvidenceSource } from '../capabilityEvidence';

const supported: ImageCapabilityValues = {
  available: true,
  models: ['gpt-image-2'],
  generate: true,
  edit: false,
  maskEdit: false,
  maxInputImages: 0,
  maxOutputImages: 1,
  streaming: false,
  maxPartialImages: 0,
  transparentBackground: false,
  flexibleSizes: true,
  outputFormats: ['png', 'jpeg', 'webp'],
  qualityLevels: ['auto', 'low', 'medium', 'high'],
  moderationModes: ['auto', 'low'],
  outputCompression: { supported: true, formats: ['jpeg', 'webp'], min: 0, max: 100 },
  responsesTool: false,
  multiTurnEdit: false,
  supportsFileId: false,
  supportsImageUrl: false,
};

const request: NormalizedImageGenerateRequest = {
  action: 'generate', model: 'gpt-image-2', prompt: 'SECRET_PROMPT_SENTINEL', n: 1,
  quality: 'auto', size: { kind: 'auto' }, background: 'auto', outputFormat: 'png',
  moderation: 'auto', stream: false, partialImages: 0,
};
const RAW_ACCOUNT_ID_SENTINEL = 'RAW_ACCOUNT_ID_SHOULD_NEVER_REACH_TRACE';

function evidenceLayer(kind: 'account' | 'upstream'): ImageCapabilityEvidenceLayer {
  return { kind, source: `${kind}-verified-test`, verifiedAt: 900, expiresAt: 2_000, values: supported };
}

const evidence: CodexImageCapabilityEvidenceSource = {
  async resolve() {
    return { account: evidenceLayer('account'), upstream: evidenceLayer('upstream') };
  },
};

function makeAuth(options: { credential?: boolean; refresh?: boolean } = {}): AuthStrategy & {
  applyHeaders: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
} {
  let applications = 0;
  const applyHeaders = vi.fn(async (headers: Record<string, string>, hints?: Parameters<AuthStrategy['applyHeaders']>[1]) => {
    applications += 1;
    if (options.credential !== false) headers.Authorization = `Bearer subscription-token-${applications}`;
    hints?.reportSelection?.(RAW_ACCOUNT_ID_SENTINEL, true);
  });
  const onUnauthorized = vi.fn(async () => options.refresh === true);
  return {
    kind: 'oauth-bearer', providerId: 'codex', applyHeaders, onUnauthorized,
    async describeStatus() { return { providerId: 'codex', ok: true }; },
  };
}

function context(controller = new AbortController()): ImageProviderContext {
  return {
    requestId: 'request-safe',
    tenantId: 'INBOUND_OMNICROSS_KEY_SENTINEL',
    sessionKey: 'session-safe',
    signal: controller.signal,
  };
}

async function eventsFor(
  auth: AuthStrategy,
  providerOptions: Partial<CodexSubscriptionImageProviderOptions> = {},
): Promise<{ events: ImageProviderEvent[]; release: () => Promise<void>; job: Awaited<ReturnType<Awaited<ReturnType<ReturnType<typeof createCodexSubscriptionImageProvider>['acquire']>>['start']>> }> {
  const provider = createCodexSubscriptionImageProvider({
    authStrategy: auth,
    evidenceSource: evidence,
    now: () => 1_000,
    ...providerOptions,
  });
  const lease = await provider.acquire(context());
  const job = await lease.start(request);
  const events: ImageProviderEvent[] = [];
  for await (const event of job.events) events.push(event);
  return { events, release: lease.release, job };
}

function terminalCode(events: readonly ImageProviderEvent[]): ImageGenerationErrorCode | undefined {
  const terminal = events.at(-1);
  return terminal?.type === 'failed' ? terminal.error.code : undefined;
}

function terminalError(events: readonly ImageProviderEvent[]) {
  const terminal = events.at(-1);
  return terminal?.type === 'failed' ? terminal.error : undefined;
}

async function waitForTraceRecord(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const line = readFileSync(path, 'utf8').trim();
      if (line) {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          // The async trace writer may have created the file before appending
          // its complete JSONL record; retry the bounded observation.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for a complete upstream trace record.');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetUpstreamProxyForTests();
  __resetUpstreamTraceForTests();
});

describe('CodexSubscriptionImageProvider negative paths', () => {
  it('fails acquisition without an eligible subscription credential and makes no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createCodexSubscriptionImageProvider({ authStrategy: makeAuth({ credential: false }) });
    await expect(provider.acquire(context())).rejects.toMatchObject({ code: 'upstream_auth_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['quality', { qualityLevels: ['auto'] }, { quality: 'high' as const }],
    ['moderation', { moderationModes: ['auto'] }, { moderation: 'low' as const }],
    ['compression', { outputCompression: { supported: false as const } }, {
      outputFormat: 'webp' as const,
      outputCompression: 75,
    }],
  ])('rejects unverified %s options before egress', async (_name, capabilityOverride, requestOverride) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const restricted = { ...supported, ...capabilityOverride } as ImageCapabilityValues;
    const restrictedEvidence: CodexImageCapabilityEvidenceSource = {
      async resolve() {
        return {
          account: { ...evidenceLayer('account'), values: restricted },
          upstream: { ...evidenceLayer('upstream'), values: restricted },
        };
      },
    };
    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(),
      evidenceSource: restrictedEvidence,
      now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    expect(() => lease.start({ ...request, ...requestOverride })).toThrow(/capability/i);
    expect(fetchMock).not.toHaveBeenCalled();
    await lease.release();
  });

  it('accepts explicitly evidenced quality, moderation, and compression without claiming default entitlement', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(), evidenceSource: evidence, now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    const job = lease.start({
      ...request,
      quality: 'high',
      moderation: 'low',
      outputFormat: 'webp',
      outputCompression: 75,
    });
    await job.cancel();
    expect(fetchMock).not.toHaveBeenCalled();
    await lease.release();
  });

  it.each([
    ['rate limit', 429, '{"error":{"code":"rate_limit"}}', 'upstream_rate_limited', 'unknown'],
    ['subscription limit', 429, '{"error":{"code":"subscription_usage_limit_reached"}}', 'subscription_usage_limit_reached', 'unknown'],
    ['moderation', 422, '{"error":{"code":"moderation_blocked"}}', 'moderation_blocked', 'unknown'],
    ['auth required', 403, '{"error":{"code":"auth"}}', 'upstream_auth_required', 'before_acceptance'],
    ['server error', 500, '{"error":{"code":"temporary"}}', 'image_generation_failed', 'unknown'],
    ['service unavailable', 503, '{"error":{"code":"temporary"}}', 'image_generation_failed', 'unknown'],
    ['gateway timeout', 504, '{"error":{"code":"timeout"}}', 'image_generation_timeout', 'unknown'],
  ])('maps %s without unverified detail', async (_name, status, body, code, retrySafety) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '17' },
    })));
    const auth = makeAuth();
    const result = await eventsFor(auth);
    expect(result.events).toHaveLength(1);
    expect(terminalCode(result.events)).toBe(code);
    expect(terminalError(result.events)?.retrySafety).toBe(retrySafety);
    expect(JSON.stringify(result.events)).not.toContain(body);
    await result.release();
  });

  it('refreshes a 401 at most once before acceptance and keeps the same account', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"auth"}}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuth({ refresh: true });
    const result = await eventsFor(auth);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth.onUnauthorized).toHaveBeenCalledOnce();
    expect(auth.applyHeaders).toHaveBeenCalledTimes(2);
    expect(terminalCode(result.events)).toBe('upstream_auth_required');
    expect(terminalError(result.events)?.retrySafety).toBe('before_acceptance');
    await result.release();
  });

  it('keeps a connection reset before an acceptance event retry-unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('UND_ERR_SOCKET: connection reset SECRET_SENTINEL');
    }));
    const result = await eventsFor(makeAuth());
    expect(terminalError(result.events)).toMatchObject({
      code: 'image_generation_failed',
      retrySafety: 'unknown',
    });
    expect(JSON.stringify(result.events)).not.toContain('SENTINEL');
    await result.release();
  });

  it('does not retry after a 2xx response has crossed the acceptance boundary', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>SECRET_RESPONSE_BODY_SENTINEL</html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = makeAuth({ refresh: true });
    const result = await eventsFor(auth);
    expect(result.events.map((event) => event.type)).toEqual(['accepted', 'failed']);
    expect(terminalCode(result.events)).toBe('upstream_protocol_changed');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.onUnauthorized).not.toHaveBeenCalled();
    expect(JSON.stringify(result.events)).not.toContain('SENTINEL');
    await result.release();
  });

  it('maps timeout and cancellation distinctly', async () => {
    const pendingFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', pendingFetch);
    const timeout = await eventsFor(makeAuth(), { generationTimeoutMs: 5 });
    expect(terminalCode(timeout.events)).toBe('image_generation_timeout');
    await timeout.release();

    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(), evidenceSource: evidence, now: () => 1_000, generationTimeoutMs: 1_000,
    });
    const lease = await provider.acquire(context());
    const job = await lease.start(request);
    const collecting = (async () => {
      const result: ImageProviderEvent[] = [];
      for await (const event of job.events) result.push(event);
      return result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await job.cancel();
    const cancelled = await collecting;
    expect(terminalCode(cancelled)).toBe('request_cancelled');
    await lease.release();
  });
});

describe('Codex subscription image egress redaction', () => {
  it('forces body redaction while retaining status/timing/bytes and never uses an inbound key as auth', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnicross-image-trace-'));
    const tracePath = join(directory, 'trace.jsonl');
    setUpstreamTracePath(tracePath);
    let capturedAuth = '';
    let resolverAccountId = '';
    setUpstreamProxyResolver((proxyContext) => {
      resolverAccountId = proxyContext.accountId ?? '';
      return undefined;
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedAuth = new Headers(init.headers).get('authorization') ?? '';
      return new Response('{"error":{"code":"rate_limit","detail":"SECRET_BASE64_SENTINEL"}}', {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const result = await eventsFor(makeAuth());
    expect(terminalCode(result.events)).toBe('upstream_rate_limited');
    expect(capturedAuth).toMatch(/^Bearer subscription-token-/);
    expect(capturedAuth).not.toContain('INBOUND_OMNICROSS_KEY_SENTINEL');
    expect(resolverAccountId).toBe(RAW_ACCOUNT_ID_SENTINEL);

    const trace = await waitForTraceRecord(tracePath);
    expect(trace.requestBody).toBe(REDACTED_BODY);
    expect(trace.responseBody).toBe(REDACTED_BODY);
    expect(trace.responseBytes).toBeGreaterThan(0);
    expect(trace.status).toBe(429);
    expect(trace.durationMs).toEqual(expect.any(Number));
    expect(trace.accountId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(trace)).not.toContain(RAW_ACCOUNT_ID_SENTINEL);
    expect(JSON.stringify(trace)).not.toContain('SECRET_PROMPT_SENTINEL');
    expect(JSON.stringify(trace)).not.toContain('SECRET_BASE64_SENTINEL');
    expect(JSON.stringify(trace)).not.toContain(capturedAuth);
    await result.release();
    rmSync(directory, { recursive: true, force: true });
  });
});
