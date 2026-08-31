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
import {
  ImageGenerationError,
  type ImageProviderContext,
} from '@omnicross/core/image-generation';
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
import type {
  ImageExecutionAccountKey,
  ImageExecutionScheduler,
  ImageExecutionSchedulerRequest,
} from '../ImageExecutionScheduler';

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
const OPAQUE_ACCOUNT_KEY = 'opaque-account-key' as ImageExecutionAccountKey;
const VALID_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVR4nGP4z8DQAMIADv0C/528KS0AAAAASUVORK5CYII=';

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
    preferredAccountGroup: 'configured-group',
    boundAccountFallbackPolicy: 'pool',
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

async function collectEvents(events: AsyncIterable<ImageProviderEvent>): Promise<ImageProviderEvent[]> {
  const collected: ImageProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
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
  vi.useRealTimers();
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

  it('bootstraps the first real generation through the Codex image bridge', async () => {
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const sse = [
      `data: ${JSON.stringify({
        type: 'response.image_generation_call.partial_image',
        partial_image_index: 0,
        partial_image_b64: VALID_PNG.slice(0, -4),
      })}`,
      `data: ${JSON.stringify({
        type: 'response.image_generation_call.partial_image',
        partial_image_index: 0,
        partial_image_b64: VALID_PNG,
      })}`,
      `data: ${JSON.stringify({
        type: 'response.completed',
        response: { usage: { total_tokens: 7 } },
      })}`,
      'data: [DONE]',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders = new Headers(init.headers);
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(sse, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = createCodexSubscriptionImageProvider({ authStrategy: makeAuth(), now: () => 1_000 });
    const lease = await provider.acquire(context());
    expect(lease.capabilities).toMatchObject({
      available: true,
      models: ['gpt-image-2'],
      generate: true,
    });
    const events = await collectEvents(lease.start(request).events);
    expect(events.map((event) => event.type)).toEqual(['accepted', 'completed']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(capturedHeaders.get('accept')).toBe('text/event-stream');
    expect(capturedHeaders.get('originator')).toBe('codex_cli_rs');
    expect(capturedHeaders.get('user-agent')).toMatch(/^codex_cli_rs\//u);
    expect(capturedHeaders.get('version')).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(capturedBody).toMatchObject({
      instructions: '',
      model: 'gpt-5.6-luna',
      stream: true,
      store: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      tool_choice: { type: 'image_generation' },
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'SECRET_PROMPT_SENTINEL' }],
      }],
      tools: [{
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        quality: 'auto',
        background: 'auto',
        output_format: 'png',
      }],
    });
    await lease.release();
  });

  it('fails closed for account mismatch, stale evidence, model mismatch, and source failure', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const cases: Array<{
      source: CodexImageCapabilityEvidenceSource;
      reason: string;
    }> = [
      {
        source: {
          async resolve({ accountId }) {
            return accountId === 'different-account'
              ? { account: evidenceLayer('account'), upstream: evidenceLayer('upstream') }
              : {
                  account: { kind: 'account', source: 'account-mismatch' },
                  upstream: { kind: 'upstream', source: 'account-mismatch' },
                };
          },
        },
        reason: 'account_unverified',
      },
      {
        source: {
          async resolve() {
            return {
              account: { ...evidenceLayer('account'), expiresAt: 999 },
              upstream: evidenceLayer('upstream'),
            };
          },
        },
        reason: 'stale_evidence',
      },
      {
        source: {
          async resolve() {
            const mismatched = { ...supported, models: ['different-model'] };
            return {
              account: { ...evidenceLayer('account'), values: mismatched },
              upstream: { ...evidenceLayer('upstream'), values: mismatched },
            };
          },
        },
        reason: 'no_common_models',
      },
      {
        source: {
          async resolve() {
            throw new Error('Bearer EVIDENCE_SOURCE_SECRET_SENTINEL');
          },
        },
        reason: 'account_unverified',
      },
    ];

    for (const item of cases) {
      const provider = createCodexSubscriptionImageProvider({
        authStrategy: makeAuth(),
        evidenceSource: item.source,
        now: () => 1_000,
      });
      const lease = await provider.acquire(context());
      expect(lease.capabilities).toMatchObject({ available: false, reason: item.reason });
      expect(JSON.stringify(lease.capabilities)).not.toContain('SECRET_SENTINEL');
      expect(() => lease.start(request)).toThrowError(/capability/i);
      await lease.release();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits unverified usage, moderation, cost, and revised-prompt fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        status: 'completed',
        result: VALID_PNG,
        revised_prompt: 'REVISED_PROMPT_SECRET_SENTINEL',
        moderation: { category: 'SECRET_MODERATION_SENTINEL' },
      }],
      usage: { total_tokens: 123, generated_images: 1 },
      cost: { usd: 99, detail: 'SECRET_COST_SENTINEL' },
    }), { status: 200 })));
    const result = await eventsFor(makeAuth());
    const completed = result.events.find((event) => event.type === 'completed');
    expect(completed).toMatchObject({ type: 'completed', images: [{ artifact: expect.anything() }] });
    expect(completed).not.toHaveProperty('usage');
    if (completed?.type === 'completed') {
      expect(completed.images[0]).not.toHaveProperty('revisedPrompt');
    }
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain('SECRET_');
    expect(serialized).not.toMatch(/moderation|cost/i);
    await result.release();
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
    expect(auth.applyHeaders.mock.calls[0]?.[1]).toMatchObject({
      preferredAccountGroup: 'configured-group',
      boundAccountFallbackPolicy: 'pool',
    });
    expect(auth.applyHeaders.mock.calls[1]?.[1]).toMatchObject({
      preferredAccountId: RAW_ACCOUNT_ID_SENTINEL,
      boundAccountFallbackPolicy: 'pool',
    });
    expect(terminalCode(result.events)).toBe('upstream_auth_required');
    expect(terminalError(result.events)?.retrySafety).toBe('before_acceptance');
    expect(result.job.observability?.snapshot()).toMatchObject({
      generationStartedAt: 1_000,
      retryCount: 1,
      authRefreshCount: 1,
    });
    expect(result.job.observability?.snapshot().queueWaitMs).toBeUndefined();
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

describe('Codex subscription image execution scheduling', () => {
  it('admits only after account selection and evidence resolution and passes no content or credential', async () => {
    const order: string[] = [];
    const schedulingInputs: ImageExecutionSchedulerRequest[] = [];
    const releaseGrant = vi.fn();
    const orderedAuth: AuthStrategy = {
      kind: 'oauth-bearer',
      providerId: 'codex',
      async applyHeaders(headers, hints) {
        order.push('account');
        headers.Authorization = 'Bearer CREDENTIAL_SENTINEL';
        hints?.reportSelection?.(RAW_ACCOUNT_ID_SENTINEL, true);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', ok: true }; },
    };
    const orderedEvidence: CodexImageCapabilityEvidenceSource = {
      async resolve() {
        order.push('evidence');
        return { account: evidenceLayer('account'), upstream: evidenceLayer('upstream') };
      },
    };
    const deriveAccountKey = vi.fn(() => OPAQUE_ACCOUNT_KEY);
    const scheduler: ImageExecutionScheduler = {
      deriveAccountKey,
      acquire(input) {
        order.push('scheduler');
        schedulingInputs.push(input);
        return { release: releaseGrant };
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('transport');
      return new Response('{"error":{"code":"rate_limit"}}', { status: 429 });
    }));

    const provider = createCodexSubscriptionImageProvider({
      authStrategy: orderedAuth,
      evidenceSource: orderedEvidence,
      executionScheduler: scheduler,
      now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    expect(order).toEqual(['account', 'evidence']);
    const job = lease.start(request);
    expect(order).toEqual(['account', 'evidence']);
    for await (const _event of job.events) {
      // Drain the provider so its scheduler grant reaches terminal cleanup.
    }

    expect(order).toEqual(['account', 'evidence', 'scheduler', 'transport']);
    expect(schedulingInputs).toHaveLength(1);
    expect(Object.keys(schedulingInputs[0]!).sort()).toEqual([
      'accountKey',
      'signal',
      'tenantId',
    ]);
    expect(schedulingInputs[0]).toMatchObject({
      tenantId: 'INBOUND_OMNICROSS_KEY_SENTINEL',
      accountKey: OPAQUE_ACCOUNT_KEY,
    });
    const schedulingProjection = {
      tenantId: schedulingInputs[0]!.tenantId,
      accountKey: schedulingInputs[0]!.accountKey,
    };
    expect(deriveAccountKey).toHaveBeenCalledOnce();
    expect(deriveAccountKey).toHaveBeenCalledWith(RAW_ACCOUNT_ID_SENTINEL);
    expect(JSON.stringify(schedulingProjection)).not.toContain(RAW_ACCOUNT_ID_SENTINEL);
    expect(JSON.stringify(schedulingProjection)).not.toContain('CREDENTIAL_SENTINEL');
    expect(JSON.stringify(schedulingProjection)).not.toContain('SECRET_PROMPT_SENTINEL');
    expect(job.observability?.snapshot()).toMatchObject({
      queueWaitMs: 0,
      generationStartedAt: 1_000,
      retryCount: 0,
      authRefreshCount: 0,
    });
    expect(releaseGrant).toHaveBeenCalledOnce();
    await lease.release();
  });

  it.each([
    'image_queue_full',
    'image_queue_timeout',
  ] as const)('preserves %s before transport', async (code) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scheduler: ImageExecutionScheduler = {
      deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
      async acquire() {
        throw new ImageGenerationError(code, { retrySafety: 'before_acceptance' });
      },
    };
    const result = await eventsFor(makeAuth(), { executionScheduler: scheduler });
    expect(terminalCode(result.events)).toBe(code);
    expect(terminalError(result.events)?.retrySafety).toBe('before_acceptance');
    expect(fetchMock).not.toHaveBeenCalled();
    await result.release();
  });

  it('releases a scheduler grant exactly once across terminal and repeated cleanup', async () => {
    const releaseGrant = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '{"error":{"code":"rate_limit"}}',
      { status: 429 },
    )));
    const result = await eventsFor(makeAuth(), {
      executionScheduler: {
        deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
        acquire: () => ({ release: releaseGrant }),
      },
    });
    await result.job.cancel();
    await result.job.cancel();
    await result.release();
    await result.release();
    expect(releaseGrant).toHaveBeenCalledOnce();
  });

  it('keeps callers without a scheduler backward-compatible', async () => {
    const fetchMock = vi.fn(async () => new Response(
      '{"error":{"code":"rate_limit"}}',
      { status: 429 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const result = await eventsFor(makeAuth());
    expect(terminalCode(result.events)).toBe('upstream_rate_limited');
    expect(fetchMock).toHaveBeenCalledOnce();
    await result.release();
  });

  it('starts generation timeout only after the scheduler grant', async () => {
    vi.useFakeTimers();
    let grantAdmission!: (grant: { release: () => void }) => void;
    const admission = new Promise<{ release: () => void }>((resolve) => {
      grantAdmission = resolve;
    });
    const releaseGrant = vi.fn();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(),
      evidenceSource: evidence,
      executionScheduler: {
        deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
        acquire: () => admission,
      },
      generationTimeoutMs: 50,
      now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    const job = lease.start(request);
    const collecting = collectEvents(job.events);

    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).not.toHaveBeenCalled();
    grantAdmission({ release: releaseGrant });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50);
    expect(terminalCode(await collecting)).toBe('image_generation_timeout');
    expect(releaseGrant).toHaveBeenCalledOnce();
    await lease.release();
  });

  it('releases once when transport throws or returns a failed terminal', async () => {
    for (const transport of [
      vi.fn(async () => { throw new TypeError('socket failure'); }),
      vi.fn(async () => new Response('{"error":{"code":"rate_limit"}}', { status: 429 })),
    ]) {
      const releaseGrant = vi.fn();
      vi.stubGlobal('fetch', transport);
      const result = await eventsFor(makeAuth(), {
        executionScheduler: {
          deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
          acquire: () => ({ release: releaseGrant }),
        },
      });
      expect(result.events.at(-1)?.type).toBe('failed');
      expect(releaseGrant).toHaveBeenCalledOnce();
      await result.release();
    }
  });

  it('releases once when the event consumer returns early', async () => {
    const releaseGrant = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', status: 'completed', result: VALID_PNG }],
    }), { status: 200 })));
    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(),
      evidenceSource: evidence,
      executionScheduler: {
        deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
        acquire: () => ({ release: releaseGrant }),
      },
      now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    const job = lease.start(request);
    const iterator = job.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('accepted');
    await iterator.return?.();
    await job.cancel();
    await job.cancel();
    expect(releaseGrant).toHaveBeenCalledOnce();
    await lease.release();
  });

  it('releases a late grant after cancellation without transport', async () => {
    let resolveGrant!: (grant: { release: () => void }) => void;
    const admission = new Promise<{ release: () => void }>((resolve) => {
      resolveGrant = resolve;
    });
    const releaseGrant = vi.fn();
    const acquire = vi.fn(() => admission);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = createCodexSubscriptionImageProvider({
      authStrategy: makeAuth(),
      evidenceSource: evidence,
      executionScheduler: {
        deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
        acquire,
      },
      now: () => 1_000,
    });
    const lease = await provider.acquire(context());
    const job = lease.start(request);
    const collecting = collectEvents(job.events);
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    await job.cancel();
    resolveGrant({ release: releaseGrant });

    expect(terminalCode(await collecting)).toBe('request_cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseGrant).toHaveBeenCalledOnce();
    await lease.release();
  });

  it('links caller and scheduler shutdown cancellation to one grant release', async () => {
    for (const cancellation of ['caller', 'scheduler'] as const) {
      const caller = new AbortController();
      const scheduler = new AbortController();
      const releaseGrant = vi.fn();
      const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
      vi.stubGlobal('fetch', fetchMock);
      const provider = createCodexSubscriptionImageProvider({
        authStrategy: makeAuth(),
        evidenceSource: evidence,
        executionScheduler: {
          deriveAccountKey: () => OPAQUE_ACCOUNT_KEY,
          acquire: () => ({ signal: scheduler.signal, release: releaseGrant }),
        },
        generationTimeoutMs: 1_000,
        now: () => 1_000,
      });
      const lease = await provider.acquire(context(caller));
      const job = lease.start(request);
      const collecting = collectEvents(job.events);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      if (cancellation === 'caller') caller.abort(new Error('caller stopped'));
      else scheduler.abort(new ImageGenerationError('request_cancelled'));

      expect(terminalCode(await collecting)).toBe('request_cancelled');
      expect(releaseGrant).toHaveBeenCalledOnce();
      await lease.release();
    }
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
