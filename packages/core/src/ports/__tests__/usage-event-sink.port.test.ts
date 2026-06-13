/**
 * Mock-based unit test for the `UsageEventSink` port (omnicross Phase 0b,
 * task 5.4).
 *
 * Sets a mock sink on `CompletionService` and asserts `emit` fires on the
 * success+usage+sessionId streaming path with the structurally-correct payload,
 * and that the path does NOT throw when no sink is wired (the `?.emit` no-ops,
 * matching the optional `usageRecorder`).
 *
 * The downstream `StreamHandler` is mocked so the openai stream invokes
 * `onDone(message, usage, metrics)` synchronously — no network — letting the
 * `completeStream` usage-emit wrapper run deterministically.
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompletionOptions, StreamCallbacks } from '../../completion';
import { CompletionService } from '../../completion/CompletionService';
import type { CorePaths } from '../core-paths';
import type { Logger } from '../logger';
import type { ProviderConfigSource } from '../provider-config-source';
import type { UsageEventSink } from '../usage-event-sink';

// Make the openai stream handler fire onDone with usage, deterministically.
vi.mock('../../completion/StreamHandler', () => ({
  streamOpenAICompletion: vi.fn(
    async (
      _provider: unknown,
      _apiKey: unknown,
      _options: unknown,
      _messageId: unknown,
      callbacks: StreamCallbacks,
    ) => {
      callbacks.onDone?.(
        { role: 'assistant', content: 'hi' } as never,
        { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        { completionTokens: 5, timeCompletionMs: 1 } as never,
      );
    },
  ),
  streamAnthropicCompletion: vi.fn(),
  streamGeminiCompletion: vi.fn(),
  streamOpenAIResponseCompletion: vi.fn(),
}));

function makePaths(): CorePaths {
  return { userData: '/tmp/u', resourcesDir: '/tmp/r' };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfigSource(provider: LLMProvider): ProviderConfigSource {
  return {
    getProvider: vi.fn(async () => provider),
    resolveRoutedModel: vi.fn(async () => null),
    resolveEffectiveModels: vi.fn(async () => ({})),
    hasVisionCapability: vi.fn(async () => true),
    getGlobalModelParameters: vi.fn(),
    getDiscoveredModelMaxTokens: vi.fn(),
    resolveTransformerChain: vi.fn(),
    getMainTransformer: vi.fn(),
    getTransformerService: vi.fn(),
  } as unknown as ProviderConfigSource;
}

function makeProvider(): LLMProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    enabled: true,
    apiFormat: 'openai',
    api_key: 'test-key',
    api_base_url: 'https://api.openai.test/v1',
  } as unknown as LLMProvider;
}

function makeOptions(): CompletionOptions {
  return {
    providerId: 'openai',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    sessionId: 'session-123',
  } as unknown as CompletionOptions;
}

describe('UsageEventSink port — mock injection (task 5.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits a structurally-correct usage event on the success+usage+sessionId path', async () => {
    const service = new CompletionService(makePaths(), makeConfigSource(makeProvider()), makeLogger());
    const emit = vi.fn();
    const sink: UsageEventSink = { emit };
    service.setUsageEventSink(sink);

    await service.completeStream(makeOptions(), {});

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session-123',
      modelId: 'gpt-4o',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      engineOrigin: 'completion',
    });
  });

  it('does NOT throw when no sink is wired (the ?.emit no-ops)', async () => {
    const service = new CompletionService(makePaths(), makeConfigSource(makeProvider()), makeLogger());
    // No setUsageEventSink call.

    await expect(service.completeStream(makeOptions(), {})).resolves.toBeUndefined();
  });
});
