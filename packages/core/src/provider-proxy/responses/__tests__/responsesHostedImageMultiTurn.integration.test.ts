import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageGenerationError } from '../../../image-generation/errors';
import {
  inspectResponsesImageRequest,
  validateResponsesImageSelection,
  type ResponsesImageCallId,
  type ResponsesImageExecutionEvent,
  type ResponsesImageRequestScope,
} from '../../../image-generation/responses';
import type { ProviderConfigSource } from '../../../ports';
import { ProviderProxy } from '../../ProviderProxy';
import type { ProviderProxyDeps, RouteContext } from '../../types';
import { createNativeResponsesHostedImageMediator } from '../hosted-image/nativeResponsesHostedImageMediator';
import type {
  ResponsesHostedImageOpenRequestInput,
  ResponsesHostedImageRuntimeFactory,
  ResponsesHostedImageRuntimeLease,
} from '../responsesHostedImageIngress';

const PRIVATE_SELECTOR = '__omnicross_private_image_selector';
const GENERATED_CALL_IDS = [
  'ig_1111111111111111',
  'ig_2222222222222222',
  'ig_3333333333333333',
] as const satisfies readonly ResponsesImageCallId[];

interface ResponseContext {
  readonly tenantId: string;
  readonly callIds: readonly ResponsesImageCallId[];
}

interface ScopeCommitRecord {
  readonly tenantId: string;
  readonly responseId: string;
  readonly authorizedPreviousResponseId?: string;
  readonly authorizedPreviousResponseKnownEmpty?: boolean;
  readonly inheritedCallIds: readonly ResponsesImageCallId[];
  readonly explicitCallIds: readonly ResponsesImageCallId[];
  readonly generatedCallIds: readonly ResponsesImageCallId[];
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

function llmConfig(upstreamUrl: string): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => ({
      id: 'native',
      name: 'Native',
      apiFormat: 'openai-response',
      api_base_url: upstreamUrl,
      api_key: 'upstream-key',
      models: ['gpt-native'],
      enabled: true,
    })),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(() => ({ getTransformer: vi.fn() })),
  } as unknown as ProviderConfigSource;
}

function route(apiKeyId: string): RouteContext {
  return {
    sessionId: `hosted-image-session-${apiKeyId}`,
    apiKeyId,
    hostedImageGenerationAllowed: true,
    targetProviderFormat: 'openai-responses',
    model: 'gpt-native',
    ingressFormat: 'openai-responses',
    authMode: 'byo',
    providerId: 'native',
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
      'session-id': 'hosted-image-affinity-session',
    },
    body: JSON.stringify(body),
  });
}

function scenarioOf(body: Record<string, unknown>): string | undefined {
  return isRecord(body.metadata) && typeof body.metadata.scenario === 'string'
    ? body.metadata.scenario
    : undefined;
}

function imageSelectionOutput(
  scenario: string,
  callId: string,
  privatePrompt: string,
): Record<string, unknown> {
  return {
    id: `fc_${scenario.replaceAll('-', '_')}`,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name: PRIVATE_SELECTOR,
    arguments: JSON.stringify({ prompt: privatePrompt }),
  };
}

function upstreamResponse(body: Record<string, unknown>): Record<string, unknown> {
  const scenario = scenarioOf(body);
  const common = {
    object: 'response',
    status: 'completed',
    usage: { input_tokens: 2, output_tokens: 3 },
  };
  switch (scenario) {
    case 'first-image':
      return {
        ...common,
        id: 'resp_image_parent',
        output: [imageSelectionOutput(
          scenario,
          'call_selector_first',
          'PRIVATE_FIRST_IMAGE_PROMPT',
        )],
        tools: body.tools,
        tool_choice: body.tool_choice,
      };
    case 'text-middle':
      return {
        ...common,
        id: 'resp_text_middle',
        output: [{
          id: 'msg_text_middle',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'A public text-only continuation.' }],
        }],
      };
    case 'later-edit':
      return {
        ...common,
        id: 'resp_later_edit',
        output: [imageSelectionOutput(
          scenario,
          'call_selector_later_edit',
          'PRIVATE_LATER_EDIT_PROMPT',
        )],
        tools: body.tools,
        tool_choice: body.tool_choice,
      };
    case 'ordinary':
      return {
        ...common,
        id: 'resp_ordinary_parent',
        output: [{
          id: 'msg_ordinary',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'An ordinary response.' }],
        }],
      };
    case 'after-ordinary-image':
      return {
        ...common,
        id: 'resp_after_ordinary_image',
        output: [imageSelectionOutput(
          scenario,
          'call_selector_known_empty',
          'PRIVATE_KNOWN_EMPTY_PROMPT',
        )],
        tools: body.tools,
      };
    case 'cross-reference':
      return {
        ...common,
        id: 'resp_cross_reference',
        output: [imageSelectionOutput(
          scenario,
          'call_selector_cross_reference',
          'PRIVATE_CROSS_TENANT_PROMPT',
        )],
        tools: body.tools,
      };
    default:
      return {
        ...common,
        id: 'resp_unexpected_scenario',
        output: [],
      };
  }
}

function createRuntimeHarness() {
  const callOwners = new Map<ResponsesImageCallId, string>();
  const responseContexts = new Map<string, ResponseContext>();
  const commits: ScopeCommitRecord[] = [];
  const knownEmptyPreviousIds: string[] = [];
  const selectedPrompts: string[] = [];
  let generatedCallIndex = 0;

  const openRequest = vi.fn(async (
    input: ResponsesHostedImageOpenRequestInput,
  ): Promise<ResponsesImageRequestScope> => {
    const previous = input.authorizedPreviousResponseId
      ? responseContexts.get(input.authorizedPreviousResponseId)
      : undefined;
    if (input.authorizedPreviousResponseId && !previous) {
      if (input.authorizedPreviousResponseKnownEmpty !== true) {
        throw new ImageGenerationError('image_reference_not_found');
      }
      knownEmptyPreviousIds.push(input.authorizedPreviousResponseId);
    }
    if (previous && previous.tenantId !== input.tenantId) {
      throw new ImageGenerationError('image_reference_not_found');
    }

    for (const callId of input.admission.explicitCallIds) {
      if (callOwners.get(callId) !== input.tenantId) {
        throw new ImageGenerationError('image_reference_not_found');
      }
    }

    const inheritedCallIds = previous?.callIds ?? [];
    const generatedCallIds: ResponsesImageCallId[] = [];
    const executeSelectedCall = vi.fn<ResponsesImageRequestScope['executeSelectedCall']>(
      (call, allocator) => {
        selectedPrompts.push(call.prompt);
        const callId = GENERATED_CALL_IDS[generatedCallIndex];
        generatedCallIndex += 1;
        if (!callId) throw new ImageGenerationError('image_generation_failed');
        generatedCallIds.push(callId);
        const outputIndex = allocator.reserveOutputIndex();
        return eventStream([{
          kind: 'started',
          outputIndex,
          item: { id: callId, type: 'image_generation_call', status: 'in_progress' },
        }, {
          kind: 'completed',
          outputIndex,
          item: {
            id: callId,
            type: 'image_generation_call',
            status: 'completed',
            result: callId === GENERATED_CALL_IDS[0] ? 'AQID' : 'BAUG',
          },
        }]);
      },
    );
    const commit = vi.fn(async (responseId: string) => {
      const callIds = [...new Set<ResponsesImageCallId>([
        ...inheritedCallIds,
        ...input.admission.explicitCallIds,
        ...generatedCallIds,
      ])];
      for (const callId of generatedCallIds) callOwners.set(callId, input.tenantId);
      responseContexts.set(responseId, Object.freeze({
        tenantId: input.tenantId,
        callIds: Object.freeze(callIds),
      }));
      commits.push(Object.freeze({
        tenantId: input.tenantId,
        responseId,
        ...(input.authorizedPreviousResponseId
          ? { authorizedPreviousResponseId: input.authorizedPreviousResponseId }
          : {}),
        ...(input.authorizedPreviousResponseKnownEmpty !== undefined
          ? { authorizedPreviousResponseKnownEmpty: input.authorizedPreviousResponseKnownEmpty }
          : {}),
        inheritedCallIds: Object.freeze([...inheritedCallIds]),
        explicitCallIds: Object.freeze([...input.admission.explicitCallIds]),
        generatedCallIds: Object.freeze([...generatedCallIds]),
      }));
    });
    return {
      executeSelectedCall,
      commit,
      waitForIdle: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
  });

  const release = vi.fn(async () => undefined);
  const runtime: ResponsesHostedImageRuntimeLease = {
    generationId: 'multi-turn-test-generation',
    inspectRequest: vi.fn(inspectResponsesImageRequest),
    validateSelection: vi.fn(validateResponsesImageSelection),
    openRequest,
    release,
  };
  const factory: ResponsesHostedImageRuntimeFactory = {
    acquire: vi.fn(async () => runtime),
  };
  const mediator = createNativeResponsesHostedImageMediator(factory, {
    createSelectorName: () => PRIVATE_SELECTOR,
    createRequestId: () => `hosted-image-request-${factory.acquire.mock.calls.length}`,
  });

  return {
    capacityEvictResponse: (responseId: string) => responseContexts.delete(responseId),
    commits,
    knownEmptyPreviousIds,
    selectedPrompts,
    openRequest,
    runtime,
    factory,
    mediator,
  };
}

function findUpstreamBody(
  bodies: readonly Record<string, unknown>[],
  scenario: string,
): Record<string, unknown> {
  const found = bodies.find((body) => scenarioOf(body) === scenario);
  if (!found) throw new Error(`Missing upstream body for scenario: ${scenario}`);
  return found;
}

function imageCallId(payload: Record<string, unknown>): ResponsesImageCallId {
  const output = payload.output;
  if (!Array.isArray(output) || !isRecord(output[0]) || typeof output[0].id !== 'string') {
    throw new Error('Expected a public image call item');
  }
  return output[0].id as ResponsesImageCallId;
}

function expectNoPrivateWire(payload: unknown, ...sentinels: readonly string[]): void {
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toContain(PRIVATE_SELECTOR);
  expect(serialized).not.toContain('function_call_output');
  expect(serialized).not.toContain('call_selector_');
  expect(serialized).not.toContain('PRIVATE_');
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

describe('Native Responses hosted image multi-turn integration', () => {
  let proxy: ProviderProxy | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.stop();
    if (upstream) await close(upstream);
    proxy = undefined;
    upstream = undefined;
  });

  async function setup() {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    upstream = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        upstreamBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(upstreamResponse(body)));
      });
    });
    const upstreamPort = await listen(upstream);
    const runtime = createRuntimeHarness();
    const deps: ProviderProxyDeps = {
      llmConfig: llmConfig(`http://127.0.0.1:${upstreamPort}/v1`),
      responsesHostedImageIngress: runtime.mediator,
    };
    proxy = new ProviderProxy(deps);
    const proxyPort = await proxy.start();
    return {
      proxyPort,
      tenantAToken: proxy.addRoute(route('tenant-a-key')),
      addTenantB: () => proxy!.addRoute(route('tenant-b-key')),
      upstreamBodies,
      runtime,
    };
  }

  it('injects one pending receipt, carries image context through text, then resolves an explicit image call', async () => {
    const h = await setup();
    const firstResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      input: 'draw the first image',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
      metadata: { scenario: 'first-image' },
    });
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as Record<string, unknown>;
    const firstCallId = imageCallId(firstPayload);
    expect(firstCallId).toBe(GENERATED_CALL_IDS[0]);
    expect(firstPayload.output).toEqual([{
      id: firstCallId,
      type: 'image_generation_call',
      status: 'completed',
      result: 'AQID',
    }]);
    expectNoPrivateWire(firstPayload, 'PRIVATE_FIRST_IMAGE_PROMPT', 'call_selector_first');

    const middleResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      previous_response_id: 'resp_image_parent',
      input: 'describe the image in text only',
      metadata: { scenario: 'text-middle' },
    });
    expect(middleResponse.status).toBe(200);
    const middlePayload = await middleResponse.json() as Record<string, unknown>;
    expect(middlePayload.id).toBe('resp_text_middle');
    expectNoPrivateWire(
      middlePayload,
      'call_selector_first',
      '{"status":"completed","image_generation_call_id":"ig_1111111111111111"}',
    );

    const middleUpstream = findUpstreamBody(h.upstreamBodies, 'text-middle');
    expect(middleUpstream.input).toEqual([{
      type: 'function_call_output',
      call_id: 'call_selector_first',
      output: '{"status":"completed","image_generation_call_id":"ig_1111111111111111"}',
    }, {
      role: 'user',
      content: [{ type: 'input_text', text: 'describe the image in text only' }],
    }]);
    expect((middleUpstream.input as unknown[]).filter(
      (item) => isRecord(item) && item.type === 'function_call_output',
    )).toHaveLength(1);

    const laterResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      previous_response_id: 'resp_text_middle',
      input: [
        { type: 'image_generation_call', id: firstCallId },
        { role: 'user', content: 'edit the retained image' },
      ],
      tools: [{ type: 'image_generation', action: 'edit' }],
      metadata: { scenario: 'later-edit' },
    });
    expect(laterResponse.status).toBe(200);
    const laterPayload = await laterResponse.json() as Record<string, unknown>;
    expect(imageCallId(laterPayload)).toBe(GENERATED_CALL_IDS[1]);
    expectNoPrivateWire(laterPayload, 'PRIVATE_LATER_EDIT_PROMPT', 'call_selector_later_edit');

    const laterUpstream = findUpstreamBody(h.upstreamBodies, 'later-edit');
    expect(laterUpstream.input).toEqual([{ role: 'user', content: 'edit the retained image' }]);
    expect(JSON.stringify(laterUpstream)).not.toContain(firstCallId);
    expect(JSON.stringify(laterUpstream)).not.toContain('function_call_output');

    expect(h.runtime.commits).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a-key',
        responseId: 'resp_image_parent',
        generatedCallIds: [firstCallId],
      }),
      expect.objectContaining({
        tenantId: 'tenant-a-key',
        responseId: 'resp_text_middle',
        authorizedPreviousResponseId: 'resp_image_parent',
        authorizedPreviousResponseKnownEmpty: false,
        inheritedCallIds: [firstCallId],
        generatedCallIds: [],
      }),
      expect.objectContaining({
        tenantId: 'tenant-a-key',
        responseId: 'resp_later_edit',
        authorizedPreviousResponseId: 'resp_text_middle',
        authorizedPreviousResponseKnownEmpty: false,
        inheritedCallIds: [firstCallId],
        explicitCallIds: [firstCallId],
        generatedCallIds: [GENERATED_CALL_IDS[1]],
      }),
    ]);
    expect(h.runtime.selectedPrompts).toEqual([
      'PRIVATE_FIRST_IMAGE_PROMPT',
      'PRIVATE_LATER_EDIT_PROMPT',
    ]);
  });

  it('treats an authorized ordinary parent as known-empty and hides cross-tenant response and call identities', async () => {
    const h = await setup();
    const ordinaryResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      input: 'ordinary text only',
      metadata: { scenario: 'ordinary' },
    });
    expect(ordinaryResponse.status).toBe(200);
    const ordinaryPayload = await ordinaryResponse.json() as Record<string, unknown>;
    expect(ordinaryPayload.id).toBe('resp_ordinary_parent');
    expect(h.runtime.factory.acquire).not.toHaveBeenCalled();

    const imageResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      previous_response_id: 'resp_ordinary_parent',
      input: 'draw after an ordinary response',
      tools: [{ type: 'image_generation' }],
      metadata: { scenario: 'after-ordinary-image' },
    });
    expect(imageResponse.status).toBe(200);
    const imagePayload = await imageResponse.json() as Record<string, unknown>;
    const tenantACallId = imageCallId(imagePayload);
    expect(h.runtime.knownEmptyPreviousIds).toEqual(['resp_ordinary_parent']);
    expect(h.runtime.openRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      authorizedPreviousResponseId: 'resp_ordinary_parent',
      authorizedPreviousResponseKnownEmpty: true,
    }));
    expect(h.runtime.commits.at(-1)).toMatchObject({
      tenantId: 'tenant-a-key',
      responseId: 'resp_after_ordinary_image',
      authorizedPreviousResponseId: 'resp_ordinary_parent',
      inheritedCallIds: [],
    });
    const knownEmptyUpstream = findUpstreamBody(h.upstreamBodies, 'after-ordinary-image');
    expect(JSON.stringify(knownEmptyUpstream)).not.toContain('function_call_output');
    expectNoPrivateWire(imagePayload, 'PRIVATE_KNOWN_EMPTY_PROMPT', 'call_selector_known_empty');

    const tenantBToken = h.addTenantB();
    const upstreamCountBeforePreviousIsolation = h.upstreamBodies.length;
    const crossPrevious = await request(h.proxyPort, tenantBToken, {
      model: 'client-model',
      previous_response_id: 'resp_after_ordinary_image',
      input: 'try another tenant response',
      metadata: { scenario: 'cross-previous' },
    });
    expect(crossPrevious.status).toBe(404);
    const crossPreviousPayload = await crossPrevious.json();
    expect(JSON.stringify(crossPreviousPayload)).toContain('previous_response_not_found');
    expectNoPrivateWire(crossPreviousPayload, 'resp_after_ordinary_image', tenantACallId);
    expect(h.upstreamBodies).toHaveLength(upstreamCountBeforePreviousIsolation);

    const selectedPromptCountBeforeCallIsolation = h.runtime.selectedPrompts.length;
    const crossReference = await request(h.proxyPort, tenantBToken, {
      model: 'client-model',
      input: [
        { type: 'image_generation_call', id: tenantACallId },
        { role: 'user', content: 'edit another tenant image' },
      ],
      tools: [{ type: 'image_generation', action: 'edit' }],
      metadata: { scenario: 'cross-reference' },
    });
    expect(crossReference.status).toBe(404);
    const crossReferencePayload = await crossReference.json();
    expect(JSON.stringify(crossReferencePayload)).toContain('image_reference_not_found');
    expectNoPrivateWire(
      crossReferencePayload,
      tenantACallId,
      'PRIVATE_CROSS_TENANT_PROMPT',
      'call_selector_cross_reference',
    );
    expect(h.runtime.selectedPrompts).toHaveLength(selectedPromptCountBeforeCallIsolation);

    const crossReferenceUpstream = findUpstreamBody(h.upstreamBodies, 'cross-reference');
    expect(JSON.stringify(crossReferenceUpstream)).not.toContain(tenantACallId);
    expect(crossReferenceUpstream.input).toEqual([
      { role: 'user', content: 'edit another tenant image' },
    ]);
  });

  it('fails closed when an image-bearing parent is capacity-evicted before a later edit', async () => {
    const h = await setup();
    const firstResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      input: 'draw the image that will be retained',
      tools: [{ type: 'image_generation' }],
      tool_choice: { type: 'image_generation' },
      metadata: { scenario: 'first-image' },
    });
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as Record<string, unknown>;
    const firstCallId = imageCallId(firstPayload);

    const middleResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      previous_response_id: 'resp_image_parent',
      input: 'carry the image through a text-only middle turn',
      metadata: { scenario: 'text-middle' },
    });
    expect(middleResponse.status).toBe(200);
    expect(h.runtime.openRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      authorizedPreviousResponseId: 'resp_image_parent',
      authorizedPreviousResponseKnownEmpty: false,
    }));
    expect(h.runtime.capacityEvictResponse('resp_text_middle')).toBe(true);

    const commitsBeforeEdit = h.runtime.commits.length;
    const selectedPromptsBeforeEdit = h.runtime.selectedPrompts.length;
    const laterResponse = await request(h.proxyPort, h.tenantAToken, {
      model: 'client-model',
      previous_response_id: 'resp_text_middle',
      input: [
        { type: 'image_generation_call', id: firstCallId },
        { role: 'user', content: 'edit after capacity eviction' },
      ],
      tools: [{ type: 'image_generation', action: 'edit' }],
      metadata: { scenario: 'later-edit' },
    });
    expect(laterResponse.status).toBe(404);
    const failure = await laterResponse.json();
    expect(JSON.stringify(failure)).toContain('image_reference_not_found');
    expectNoPrivateWire(
      failure,
      firstCallId,
      'PRIVATE_LATER_EDIT_PROMPT',
      'call_selector_later_edit',
    );
    expect(h.runtime.openRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      authorizedPreviousResponseId: 'resp_text_middle',
      authorizedPreviousResponseKnownEmpty: false,
    }));
    expect(h.runtime.knownEmptyPreviousIds).toEqual([]);
    expect(h.runtime.commits).toHaveLength(commitsBeforeEdit);
    expect(h.runtime.selectedPrompts).toHaveLength(selectedPromptsBeforeEdit);
  });
});
