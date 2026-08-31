import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
  type ResponsesImageCallId,
  type ResponsesImageExecutionEvent,
  type ResponsesImageRequestScope,
} from '../../../image-generation/responses';
import type { AuthApplyHints } from '../../../pipeline/AuthSource';
import {
  __clearAuditUsageForTests,
  readAuditUsage,
} from '../../../pipeline/auditUsageStash';
import type { ProviderConfigSource } from '../../../ports';
import { UsageRecorder } from '../../../usage';
import { ProviderProxy } from '../../ProviderProxy';
import type {
  ProviderProxyDeps,
  RouteContext,
  UsageRecordImportInput,
  UsageRecorderImport,
} from '../../types';
import { getResponsesAffinityStore } from '../responsesAffinity';
import { createNativeResponsesHostedImageMediator } from '../hosted-image/nativeResponsesHostedImageMediator';
import type {
  ResponsesHostedImageOpenRequestInput,
  ResponsesHostedImageRuntimeFactory,
  ResponsesHostedImageRuntimeLease,
} from '../responsesHostedImageIngress';

const PRIVATE_SELECTOR = '__omnicross_private_security_selector';
const PRIVATE_SUCCESS_PROMPT = 'PRIVATE_SUCCESS_PROMPT_SENTINEL_FULL_TEXT';
const PRIVATE_MALFORMED_PROMPT = 'PRIVATE_MALFORMED_PROMPT_SENTINEL';
const PRIVATE_MALFORMED_ARGUMENTS = 'PRIVATE_MALFORMED_ARGUMENTS_SENTINEL';
const PRIVATE_PROVIDER_PROMPT = 'PRIVATE_PROVIDER_FAILURE_PROMPT_SENTINEL';
const PRIVATE_COMMIT_PROMPT = 'PRIVATE_COMMIT_FAILURE_PROMPT_SENTINEL';
const PRIVATE_PROVIDER_FAILURE = 'PRIVATE_PROVIDER_FAILURE_SENTINEL';
const PRIVATE_COMMIT_FAILURE = 'PRIVATE_COMMIT_FAILURE_SENTINEL';
const PRIVATE_CREDENTIAL = 'Bearer PRIVATE_CREDENTIAL_TOKEN_SENTINEL';
const PRIVATE_ACCOUNT_ID = 'account_PRIVATE_ACCOUNT_ID_SENTINEL';
const PRIVATE_PROVIDER_REFERENCE = 'ref_PRIVATE_PROVIDER_REFERENCE_SENTINEL';
const PRIVATE_INPUT_IMAGE = 'data:image/png;base64,PRIVATE_INPUT_IMAGE_SENTINEL';
const PRIVATE_IMAGE_BYTES = 'PRIVATE_IMAGE_BYTES_SENTINEL';
const INPUT_IMAGE_CALL_ID = 'ig_inputimage0000001' as const;
const PUBLIC_IMAGE_CALL_ID = 'ig_1234567890abcdef' as const;
const PRIVATE_UPSTREAM_CALL_ID = 'call_private_receipt_wire_1';
const LEGITIMATE_FINAL_RESULT = 'AQIDBA==';

const PRIVATE_SENTINELS = [
  PRIVATE_SELECTOR,
  PRIVATE_SUCCESS_PROMPT,
  PRIVATE_MALFORMED_PROMPT,
  PRIVATE_MALFORMED_ARGUMENTS,
  PRIVATE_PROVIDER_PROMPT,
  PRIVATE_COMMIT_PROMPT,
  PRIVATE_PROVIDER_FAILURE,
  PRIVATE_COMMIT_FAILURE,
  PRIVATE_CREDENTIAL,
  PRIVATE_ACCOUNT_ID,
  PRIVATE_PROVIDER_REFERENCE,
  PRIVATE_INPUT_IMAGE,
  PRIVATE_IMAGE_BYTES,
  INPUT_IMAGE_CALL_ID,
  PRIVATE_UPSTREAM_CALL_ID,
] as const;

interface PrivateScopeObservation {
  readonly accountId?: string;
  readonly explicitCallIds: readonly ResponsesImageCallId[];
  readonly providerReference?: string;
  readonly inputImage?: string;
  readonly imageBytes?: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  }));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function eventStream(
  events: readonly ResponsesImageExecutionEvent[],
): AsyncIterable<ResponsesImageExecutionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function expectNoPrivateSentinels(value: unknown): void {
  const snapshot = inspect(value, { depth: 12, breakLength: Infinity });
  for (const sentinel of PRIVATE_SENTINELS) expect(snapshot).not.toContain(sentinel);
}

function scenarioOf(body: Record<string, unknown>): string | undefined {
  return isRecord(body.metadata) && typeof body.metadata.scenario === 'string'
    ? body.metadata.scenario
    : undefined;
}

function selectorOutput(
  scenario: string,
  prompt: string,
  malformed = false,
): Record<string, unknown> {
  return {
    id: `fc_${scenario.replaceAll('-', '_')}`,
    type: 'function_call',
    status: 'completed',
    call_id: PRIVATE_UPSTREAM_CALL_ID,
    name: PRIVATE_SELECTOR,
    arguments: malformed
      ? JSON.stringify({ prompt, secret: PRIVATE_MALFORMED_ARGUMENTS })
      : JSON.stringify({ prompt }),
  };
}

function upstreamResponse(body: Record<string, unknown>): Record<string, unknown> {
  const scenario = scenarioOf(body);
  const common = {
    object: 'response',
    status: 'completed',
    model: 'gpt-native',
    usage: {
      input_tokens: 7,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 2 },
    },
  };
  if (scenario === 'success-continuation') {
    return {
      ...common,
      id: 'resp_security_continuation',
      output: [{
        id: 'msg_security_continuation',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Safe public continuation.' }],
      }],
    };
  }

  const cases: Record<string, { responseId: string; prompt: string; malformed?: boolean }> = {
    'success-image': {
      responseId: 'resp_security_image',
      prompt: PRIVATE_SUCCESS_PROMPT,
    },
    malformed: {
      responseId: 'resp_security_malformed',
      prompt: PRIVATE_MALFORMED_PROMPT,
      malformed: true,
    },
    'provider-failure': {
      responseId: 'resp_security_provider_failure',
      prompt: PRIVATE_PROVIDER_PROMPT,
    },
    'commit-failure': {
      responseId: 'resp_security_commit_failure',
      prompt: PRIVATE_COMMIT_PROMPT,
    },
  };
  const selected = scenario ? cases[scenario] : undefined;
  return selected
    ? {
        ...common,
        id: selected.responseId,
        output: [selectorOutput(scenario!, selected.prompt, selected.malformed)],
        tools: body.tools,
        tool_choice: body.tool_choice,
      }
    : { ...common, id: 'resp_security_unexpected', output: [] };
}

function llmConfig(): ProviderConfigSource {
  return {
    getProvider: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function subscriptionRoute(authStrategy: unknown, upstreamUrl: string): RouteContext {
  return {
    sessionId: 'security-session',
    apiKeyId: 'security-client-key',
    hostedImageGenerationAllowed: true,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'subscription',
    subscriptionProfile: {
      authStrategy: authStrategy as never,
      providerTransformerNames: ['metrics-side-tap', 'openai-response'],
      resolveUpstreamUrl: () => upstreamUrl,
    },
  };
}

function request(
  proxyPort: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'session-id': 'security-affinity-session',
    },
    body: JSON.stringify(body),
  });
}

function createRuntimeHarness() {
  const scopeObservations: PrivateScopeObservation[] = [];
  const selectedPrompts: string[] = [];
  const commit = vi.fn(async (responseId: string) => {
    const prompt = selectedPrompts.at(-1);
    if (prompt === PRIVATE_COMMIT_PROMPT) {
      throw new Error([
        PRIVATE_COMMIT_FAILURE,
        PRIVATE_PROVIDER_REFERENCE,
        PRIVATE_IMAGE_BYTES,
        PRIVATE_ACCOUNT_ID,
      ].join(' '));
    }
    expect(responseId).toMatch(/^resp_[A-Za-z0-9_-]+$/);
  });
  const openRequest = vi.fn(async (
    input: ResponsesHostedImageOpenRequestInput,
  ): Promise<ResponsesImageRequestScope> => {
    const resolvesPrivateInput = input.admission.explicitCallIds.includes(INPUT_IMAGE_CALL_ID);
    scopeObservations.push(Object.freeze({
      ...(input.selectedMainAccountId ? { accountId: input.selectedMainAccountId } : {}),
      explicitCallIds: Object.freeze([...input.admission.explicitCallIds]),
      ...(resolvesPrivateInput
        ? {
            providerReference: PRIVATE_PROVIDER_REFERENCE,
            inputImage: PRIVATE_INPUT_IMAGE,
            imageBytes: PRIVATE_IMAGE_BYTES,
          }
        : {}),
    }));
    return {
      executeSelectedCall(call, allocator) {
        selectedPrompts.push(call.prompt);
        const outputIndex = allocator.reserveOutputIndex();
        if (call.prompt === PRIVATE_PROVIDER_PROMPT) {
          return eventStream([{
            kind: 'failed',
            outputIndex,
            error: {
              type: 'image_generation_error',
              code: 'image_generation_failed',
              message: [
                PRIVATE_PROVIDER_FAILURE,
                PRIVATE_PROVIDER_REFERENCE,
                PRIVATE_INPUT_IMAGE,
                PRIVATE_IMAGE_BYTES,
                PRIVATE_ACCOUNT_ID,
              ].join(' '),
              httpStatus: 502,
            },
          }]);
        }
        return eventStream([{
          kind: 'started',
          outputIndex,
          item: {
            id: PUBLIC_IMAGE_CALL_ID,
            type: 'image_generation_call',
            status: 'in_progress',
          },
        }, {
          kind: 'completed',
          outputIndex,
          item: {
            id: PUBLIC_IMAGE_CALL_ID,
            type: 'image_generation_call',
            status: 'completed',
            result: LEGITIMATE_FINAL_RESULT,
          },
        }]);
      },
      commit,
      waitForIdle: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
  });
  const runtime: ResponsesHostedImageRuntimeLease = {
    generationId: 'security-generation',
    inspectRequest: vi.fn(inspectResponsesImageRequest),
    validateSelection: vi.fn(validateResponsesImageSelection),
    openRequest,
    release: vi.fn(async () => undefined),
  };
  const factory: ResponsesHostedImageRuntimeFactory = {
    acquire: vi.fn(async () => runtime),
  };
  return { commit, factory, openRequest, runtime, scopeObservations, selectedPrompts };
}

function createAuditedUsageRecorder() {
  const recorder = new UsageRecorder(
    {} as never,
    {} as never,
    { warn: vi.fn() } as never,
    { defer: () => undefined },
  );
  const record = vi.spyOn(recorder, 'record');
  return {
    recorder: recorder as unknown as UsageRecorderImport,
    record,
  };
}

function safeUsageSnapshot(input: UsageRecordImportInput): Record<string, unknown> {
  const { auditResponse: _opaqueCorrelationKey, ...snapshot } = input;
  return snapshot;
}

describe('Native Responses hosted image security integration', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;
  const auditKeys: object[] = [];

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    for (const key of auditKeys.splice(0)) __clearAuditUsageForTests(key);
    vi.restoreAllMocks();
    proxy = undefined;
    upstream = undefined;
  });

  async function setup() {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const upstreamAuthorizations: Array<string | undefined> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        upstreamBodies.push(body);
        upstreamAuthorizations.push(req.headers.authorization);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(upstreamResponse(body)));
      });
    });
    const upstreamPort = await listen(upstream);
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/responses`;
    const authStrategy = {
      providerId: 'codex',
      kind: 'oauth-bearer',
      async applyHeaders(target: Record<string, string>, hints?: AuthApplyHints) {
        target.Authorization = PRIVATE_CREDENTIAL;
        hints?.reportSelection?.(PRIVATE_ACCOUNT_ID, true);
      },
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', configured: true }; },
    };
    const runtime = createRuntimeHarness();
    const usage = createAuditedUsageRecorder();
    const deps: ProviderProxyDeps = {
      llmConfig: llmConfig(),
      usageRecorder: usage.recorder,
      responsesHostedImageIngress: createNativeResponsesHostedImageMediator(
        runtime.factory,
        {
          createSelectorName: () => PRIVATE_SELECTOR,
          createRequestId: () => 'security-request-id',
        },
      ),
    };
    const affinityStore = getResponsesAffinityStore(deps);
    const affinityRecord = vi.spyOn(affinityStore, 'record');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    const token = proxy.addRoute(subscriptionRoute(authStrategy, upstreamUrl));
    return {
      affinityRecord,
      affinityStore,
      consoleSpies: [consoleError, consoleWarn, consoleLog] as const,
      deps,
      proxyPort,
      runtime,
      token,
      upstreamAuthorizations,
      upstreamBodies,
      usage,
    };
  }

  it('keeps every private selector/runtime sentinel out of public, usage, audit, logs, and hosted affinity metadata', async () => {
    const h = await setup();
    const imageResponse = await request(h.proxyPort, h.token, {
      model: 'client-model',
      input: [
        { type: 'image_generation_call', id: INPUT_IMAGE_CALL_ID },
        { role: 'user', content: 'edit the private input image' },
      ],
      tools: [{ type: 'image_generation', action: 'edit' }],
      tool_choice: { type: 'image_generation' },
      metadata: { scenario: 'success-image' },
    });
    expect(imageResponse.status).toBe(200);
    const imagePayload = await imageResponse.json() as Record<string, unknown>;
    expect(imagePayload).toMatchObject({
      id: 'resp_security_image',
      output: [{
        id: PUBLIC_IMAGE_CALL_ID,
        type: 'image_generation_call',
        status: 'completed',
        result: LEGITIMATE_FINAL_RESULT,
      }],
    });
    expectNoPrivateSentinels(imagePayload);

    expect(h.runtime.scopeObservations[0]).toEqual({
      accountId: PRIVATE_ACCOUNT_ID,
      explicitCallIds: [INPUT_IMAGE_CALL_ID],
      providerReference: PRIVATE_PROVIDER_REFERENCE,
      inputImage: PRIVATE_INPUT_IMAGE,
      imageBytes: PRIVATE_IMAGE_BYTES,
    });
    expect(h.runtime.selectedPrompts).toEqual([PRIVATE_SUCCESS_PROMPT]);
    expect(h.upstreamAuthorizations[0]).toBe(PRIVATE_CREDENTIAL);
    expect(inspect(h.upstreamBodies[0], { depth: 10 })).toContain(PRIVATE_SELECTOR);
    expect(inspect(h.upstreamBodies[0], { depth: 10 })).not.toContain(INPUT_IMAGE_CALL_ID);

    const continuationResponse = await request(h.proxyPort, h.token, {
      model: 'client-model',
      previous_response_id: 'resp_security_image',
      input: 'continue with public text',
      metadata: { scenario: 'success-continuation' },
    });
    expect(continuationResponse.status).toBe(200);
    const continuationPayload = await continuationResponse.json() as Record<string, unknown>;
    expect(continuationPayload).toMatchObject({ id: 'resp_security_continuation' });
    expectNoPrivateSentinels(continuationPayload);

    const continuationUpstream = h.upstreamBodies[1]!;
    expect(continuationUpstream.input).toEqual([{
      type: 'function_call_output',
      call_id: PRIVATE_UPSTREAM_CALL_ID,
      output: `{"status":"completed","image_generation_call_id":"${PUBLIC_IMAGE_CALL_ID}"}`,
    }, {
      role: 'user',
      content: [{ type: 'input_text', text: 'continue with public text' }],
    }]);

    expect(h.usage.record).toHaveBeenCalledTimes(2);
    for (const [usageInput] of h.usage.record.mock.calls) {
      expectNoPrivateSentinels(safeUsageSnapshot(usageInput));
      expect(usageInput.rawUsage).toEqual({
        input_tokens: 7,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 2 },
      });
      expect(usageInput.auditResponse).toBeDefined();
      const auditKey = usageInput.auditResponse!;
      auditKeys.push(auditKey);
      const auditSnapshot = readAuditUsage(auditKey);
      expect(auditSnapshot).toEqual({
        inputTokens: 5,
        outputTokens: 5,
        model: 'gpt-native',
        provider: 'codex',
      });
      expectNoPrivateSentinels(auditSnapshot);
    }

    const imageAffinityCalls = h.affinityRecord.mock.calls.filter(
      ([record]) => record.responseId === 'resp_security_image',
    );
    expect(imageAffinityCalls).toHaveLength(2);
    for (const [record] of imageAffinityCalls) {
      expect(record.credential).toEqual({
        kind: 'subscription-account',
        id: PRIVATE_ACCOUNT_ID,
      });
      const hosted = record.hostedImage!;
      expect(Object.keys(hosted).sort()).toEqual(['hasImageContext', 'pendingReceipts']);
      expect(hosted).toEqual({
        hasImageContext: true,
        pendingReceipts: [{
          upstreamCallId: PRIVATE_UPSTREAM_CALL_ID,
          publicImageCallId: PUBLIC_IMAGE_CALL_ID,
        }],
      });
      expect(Object.keys(hosted.pendingReceipts[0]!).sort()).toEqual([
        'publicImageCallId',
        'upstreamCallId',
      ]);
      const hostedSnapshot = inspect(hosted, { depth: 10 });
      for (const forbidden of [
        PRIVATE_SUCCESS_PROMPT,
        PRIVATE_CREDENTIAL,
        PRIVATE_ACCOUNT_ID,
        PRIVATE_PROVIDER_REFERENCE,
        PRIVATE_INPUT_IMAGE,
        PRIVATE_IMAGE_BYTES,
        INPUT_IMAGE_CALL_ID,
        LEGITIMATE_FINAL_RESULT,
      ]) {
        expect(hostedSnapshot).not.toContain(forbidden);
      }
      expect(hosted.pendingReceipts[0]!.upstreamCallId).toMatch(/^call_[A-Za-z0-9_-]{1,240}$/);
      expect(hosted.pendingReceipts[0]!.publicImageCallId).toMatch(/^ig_[A-Za-z0-9_-]{16,128}$/);
    }

    const recorded = imageAffinityCalls.at(-1)![0];
    const stored = h.affinityStore.lookup('resp_security_image', {
      providerId: recorded.providerId,
      clientScope: recorded.clientScope,
      sessionKey: recorded.sessionKey,
    });
    expect(stored.hostedImage).toEqual(imageAffinityCalls.at(-1)![0].hostedImage);
    expectNoPrivateSentinels(h.consoleSpies.flatMap((spy) => spy.mock.calls));
  });

  it.each([
    {
      scenario: 'malformed',
      expectedCode: 'upstream_protocol_changed',
      expectedMessage: 'The upstream image protocol could not be recognized.',
    },
    {
      scenario: 'provider-failure',
      expectedCode: 'image_generation_failed',
      expectedMessage: 'The upstream image generation failed.',
    },
    {
      scenario: 'commit-failure',
      expectedCode: 'image_generation_failed',
      expectedMessage: 'The upstream image generation failed.',
    },
  ])('sanitizes $scenario into a stable structured error with no usage, audit, or log leakage', async ({
    scenario,
    expectedCode,
    expectedMessage,
  }) => {
    const h = await setup();
    const response = await request(h.proxyPort, h.token, {
      model: 'client-model',
      input: 'exercise a private failure path',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
      metadata: { scenario },
    });

    expect(response.status).toBe(502);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({
      error: {
        message: expectedMessage,
        type: 'openai_operation_error',
        code: expectedCode,
        retryable: false,
      },
    });
    expectNoPrivateSentinels(payload);
    expect(h.usage.record).not.toHaveBeenCalled();
    expect(h.affinityRecord).not.toHaveBeenCalled();
    expect(h.upstreamAuthorizations).toEqual([PRIVATE_CREDENTIAL]);
    expectNoPrivateSentinels(h.consoleSpies.flatMap((spy) => spy.mock.calls));
  });
});
