/**
 * AntigravityTransformer tests — deterministic, no live network
 * (antigravity-subscription-provider group-3 gates, task 3.7):
 *   - envelope snapshot: requestId/sessionId/labels/UA/userAgent/requestType
 *     against the reference client's captured wire shape,
 *   - effort variant mapping (logical id + effort → wire id) across the three
 *     families, incl. the canonical-thinkingLevels gating,
 *   - per-wire-id maxOutputTokens profile clamp (Claude 64000 / Gemini 65535+),
 *   - VALIDATED tool-mode default with tools (explicit NONE wins; ANY injects
 *     the pinned forced-tool directive for non-Claude families only),
 *   - UA probe tri-state (success / timeout-fallback / env skip),
 *   - sandbox failover switch both states (ON swaps, OFF never),
 *   - gemini byte-equivalence re-run note: the SHARED components
 *     (`ccaEnvelope`) are re-asserted through the gemini transformer's own
 *     suite (8 tests, unchanged) — the last block pins the shared pieces here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LLMProvider, TransformerContext, UnifiedChatRequest } from '../../types';
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_FORCED_TOOL_DIRECTIVE,
  AntigravityTransformer,
  buildAntigravityUrl,
  deriveAntigravitySessionId,
  resolveAntigravityWireModelId,
} from '../transformers/AntigravityTransformer';
import {
  DEFAULT_ANTIGRAVITY_VERSION,
  __resetAntigravityVersionCache,
  ensureAntigravityVersion,
  getAntigravityUserAgent,
  parseAntigravityManifestVersion,
} from '../transformers/antigravityIdentity';
import {
  __resetAntigravityFailoverState,
  isAntigravityRetryableFailure,
  fetchWithAntigravityFailover,
  maybeAntigravityFailoverUrl,
  setAntigravitySandboxFailover,
} from '../transformers/antigravityFailover';
import { peelCcaResponseEnvelope } from '../transformers/ccaEnvelope';

beforeEach(() => vi.stubEnv('ANTIGRAVITY_VERSION', DEFAULT_ANTIGRAVITY_VERSION));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); __resetAntigravityVersionCache(); });

const ctx: TransformerContext = {};

function provider(geminiProject?: string): LLMProvider {
  return {
    name: 'antigravity',
    baseUrl: ANTIGRAVITY_ENDPOINT,
    apiKey: '',
    models: ['gemini-3.5-flash'],
    geminiProject,
  };
}

function request(overrides: Partial<UnifiedChatRequest> = {}): UnifiedChatRequest {
  return {
    model: 'gemini-3.5-flash',
    messages: [{ role: 'user', content: 'Hello Antigravity' }],
    ...overrides,
  };
}

function antigravityTransformer(): AntigravityTransformer {
  return new AntigravityTransformer();
}

async function envelopeFor(
  req: UnifiedChatRequest,
  proj?: string,
): Promise<{ body: Record<string, unknown>; config: { url: string; headers: Record<string, string | undefined> } }> {
  const out = await antigravityTransformer().transformRequestIn(req, provider(proj), ctx);
  return out as unknown as {
    body: Record<string, unknown>;
    config: { url: string; headers: Record<string, string | undefined> };
  };
}

describe('AntigravityTransformer envelope snapshot', () => {
  it('carries the reference client wire shape (requestId/sessionId/labels/UA)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body, config } = await envelopeFor(request(), 'proj-1');

    // Outer envelope.
    expect(body.project).toBe('proj-1');
    expect(body.userAgent).toBe('antigravity');
    expect(body.requestType).toBe('agent');
    // No effort intent → the reference's default variant id for 3.5-flash.
    expect(body.model).toBe('gemini-3.5-flash-extra-low');
    // requestId: agent/<uuid>/<ts>/<uuid>/<step>.
    expect(String(body.requestId)).toMatch(/^agent\/[0-9a-f-]{36}\/\d+\/[0-9a-f-]{36}\/\d+$/);

    const inner = body.request as Record<string, unknown>;
    // sessionId: signed-decimal, derived from the conversation anchor.
    expect(String(inner.sessionId)).toMatch(/^-?\d+$/);
    // labels: last_step_index trails the step; telemetry tokens present.
    const labels = inner.labels as Record<string, string>;
    expect(Number(labels.last_step_index)).toBeGreaterThanOrEqual(1);
    expect(labels.trajectory_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(labels.used_claude).toBe('false');
    expect(labels.used_claude_conservative).toBe('false');
    // gemini wire profile carries the model_enum telemetry token (the
    // extra-low default variant's M187 token).
    expect(labels.model_enum).toBe('MODEL_PLACEHOLDER_M187');

    // URL + UA.
    expect(config.url).toBe(`${ANTIGRAVITY_ENDPOINT}/v1internal:generateContent`);
    expect(config.headers['User-Agent']).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=darwin; arch=arm64; cl=963137146\)$/);
    // Bearer-only: x-goog-api-key cleared.
    expect(config.headers['x-goog-api-key']).toBeUndefined();
    expect(config.headers['X-Goog-Api-Key']).toBeUndefined();
  });

  it('derives a STABLE sessionId per conversation and a step from assistant turns', async () => {
    expect(deriveAntigravitySessionId('same conversation')).toBe(deriveAntigravitySessionId('same conversation'));
    expect(deriveAntigravitySessionId('a')).not.toBe(deriveAntigravitySessionId('b'));

    const twoTurns = request({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'and now?' },
      ],
    });
    const { body } = await envelopeFor(twoTurns);
    // 1 assistant turn → step 3, last_step_index 2.
    const labels = (body.request as Record<string, unknown>).labels as Record<string, string>;
    expect(labels.last_step_index).toBe('2');
  });

  it('builds the stream URL with alt=sse', () => {
    expect(buildAntigravityUrl(true)).toBe(
      `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    );
  });
});

describe('effort variant mapping', () => {
  it('routes gemini effort variants per the reference collapse table', () => {
    // 3.5-flash budget transport.
    expect(resolveAntigravityWireModelId('gemini-3.5-flash', request({ reasoning: { effort: 'low', enabled: true } })).wireModelId).toBe('gemini-3.5-flash-extra-low');
    expect(resolveAntigravityWireModelId('gemini-3.5-flash', request({ reasoning: { effort: 'medium', enabled: true } })).wireModelId).toBe('gemini-3.5-flash-low');
    expect(resolveAntigravityWireModelId('gemini-3.5-flash', request({ reasoning: { effort: 'high', enabled: true } })).wireModelId).toBe('gemini-3-flash-agent');
    // 3.6+ google-level transport.
    expect(resolveAntigravityWireModelId('gemini-3.8-flash', request({ reasoning: { effort: 'medium', enabled: true } })).wireModelId).toBe('gemini-3.8-flash-medium');
    // 3.1-pro.
    expect(resolveAntigravityWireModelId('gemini-3.1-pro', request({ reasoning: { effort: 'high', enabled: true } })).wireModelId).toBe('gemini-pro-agent');
    // off routes.
    expect(resolveAntigravityWireModelId('gemini-3-pro', request({ reasoning: { effort: 'none', enabled: false } })).wireModelId).toBe('gemini-3-pro-low');
  });

  it('routes Claude thinking variants as independent wire ids', () => {
    expect(resolveAntigravityWireModelId('claude-opus-4-6', request({ model: 'claude-opus-4-6' })).wireModelId).toBe('claude-opus-4-6-thinking');
    expect(resolveAntigravityWireModelId('claude-opus-4-6', request({ model: 'claude-opus-4-6', reasoning: { effort: 'none', enabled: false } })).wireModelId).toBe('claude-opus-4-6-thinking');
    expect(resolveAntigravityWireModelId('claude-sonnet-4-6', request({ model: 'claude-sonnet-4-6', reasoning: { effort: 'high', enabled: true } })).wireModelId).toBe('claude-sonnet-4-6');
    expect(resolveAntigravityWireModelId('claude-sonnet-4-5', request({ model: 'claude-sonnet-4-5', reasoning: { effort: 'high', enabled: true } })).wireModelId).toBe('claude-sonnet-4-5-thinking');
    expect(resolveAntigravityWireModelId('claude-sonnet-4-5', request({ model: 'claude-sonnet-4-5' })).wireModelId).toBe('claude-sonnet-4-5');
  });

  it('routes gpt-oss to its -medium wire id for any effort', () => {
    expect(resolveAntigravityWireModelId('gpt-oss-120b', request({ model: 'gpt-oss-120b', reasoning: { effort: 'high', enabled: true } })).wireModelId).toBe('gpt-oss-120b-medium');
  });

  it('never routes a variant for a model with no canonical thinking levels', () => {
    // tab_* autocomplete models have NO reasoning — an effort intent is ignored.
    const resolution = resolveAntigravityWireModelId('tab_flash_lite_preview', request({ model: 'tab_flash_lite_preview', reasoning: { effort: 'high', enabled: true } }));
    expect(resolution.wireModelId).toBe('tab_flash_lite_preview');
    expect(resolution.variantEngaged).toBe(false);
  });

  it('drops thinkingConfig when the wire id encodes the effort', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(request({ reasoning: { effort: 'low', enabled: true } }));
    const generationConfig = ((body.request as Record<string, unknown>).generationConfig ?? {}) as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toBeUndefined();
    // …and clamps maxOutputTokens to the wire profile (65536 for -extra-low).
    expect(generationConfig.maxOutputTokens).toBe(65536);
  });
});

describe('maxOutputTokens profile clamp', () => {
  it('clamps Claude wire ids to 64000', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(
      request({ model: 'claude-opus-4-6', max_tokens: 128000, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const generationConfig = ((body.request as Record<string, unknown>).generationConfig ?? {}) as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(64000);
    expect(body.model).toBe('claude-opus-4-6-thinking');
  });

  it('keeps the request value for ids without a profile', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(request({ model: 'gemini-3.1-flash-lite', max_tokens: 1234, messages: [{ role: 'user', content: 'hi' }] }));
    const generationConfig = ((body.request as Record<string, unknown>).generationConfig ?? {}) as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(1234);
  });
});

describe('tool mode decoration', () => {
  const tool = {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } as Record<string, unknown>,
    },
  };

  it('defaults to VALIDATED when tools are present (explicit NONE wins)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(request({ tools: [tool] }));
    const toolConfig = (body.request as Record<string, unknown>).toolConfig as { functionCallingConfig: { mode: string } };
    expect(toolConfig.functionCallingConfig.mode).toBe('VALIDATED');

    const none = await envelopeFor(request({ tools: [tool], tool_choice: 'none' }));
    const noneToolConfig = (none.body.request as Record<string, unknown>).toolConfig as { functionCallingConfig: { mode: string } };
    expect(noneToolConfig.functionCallingConfig.mode).toBe('NONE');
  });

  it('injects the pinned forced-tool directive for forced choice on non-Claude families', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(request({ tools: [tool], tool_choice: 'required' }));
    const inner = body.request as Record<string, unknown>;
    const toolConfig = inner.toolConfig as { functionCallingConfig: { mode: string } };
    expect(toolConfig.functionCallingConfig.mode).toBe('ANY');
    const contents = inner.contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
    const last = contents[contents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts[0]?.text).toBe(ANTIGRAVITY_FORCED_TOOL_DIRECTIVE);
  });

  it('Claude family: ALWAYS VALIDATED + legacy parameters schema, no model_enum, anthropic-beta header', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body, config } = await envelopeFor(
      request({ model: 'claude-sonnet-4-5', tools: [tool], messages: [{ role: 'user', content: 'hi' }] }),
    );
    const inner = body.request as Record<string, unknown>;
    const toolConfig = inner.toolConfig as { functionCallingConfig: { mode: string } };
    expect(toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
    // Legacy parameters schema.
    const toolsOut = inner.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    const declaration = toolsOut[0]?.functionDeclarations[0];
    expect(declaration?.parameters).toBeDefined();
    expect(declaration?.parametersJsonSchema).toBeUndefined();
    // No model_enum for the Claude family.
    const labels = inner.labels as Record<string, string>;
    expect(labels.model_enum).toBeUndefined();
    expect(labels.used_claude).toBe('true');
    // The thinking beta header rides the Claude family.
    expect(config.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
  });

  it('Claude tool-less request still carries VALIDATED', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = await envelopeFor(request({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }));
    const toolConfig = (body.request as Record<string, unknown>).toolConfig as { functionCallingConfig: { mode: string } };
    expect(toolConfig.functionCallingConfig.mode).toBe('VALIDATED');
  });
});

describe('UA version probe tri-state', () => {
  it('parses the electron-builder manifest version line', () => {
    expect(parseAntigravityManifestVersion('version: 3.1.4\nfiles: []')).toBe('3.1.4');
    expect(parseAntigravityManifestVersion('version: "3.1.4"')).toBe('3.1.4');
    expect(parseAntigravityManifestVersion('noversionhere')).toBeNull();
    expect(parseAntigravityManifestVersion('version: not-semver')).toBeNull();
  });

  it('success: the probe caches the manifest version into the UA', async () => {
    __resetAntigravityVersionCache();
    delete process.env['ANTIGRAVITY_VERSION'];
    const fetcher = vi.fn(async () => new Response('version: 9.9.9\n', { status: 200 }));
    await ensureAntigravityVersion(fetcher);
    expect(getAntigravityUserAgent()).toContain('antigravity/hub/9.9.9');
    __resetAntigravityVersionCache();
  });

  it('timeout/garbage: falls back to the pinned 2.8.0 WITHOUT failing the path', async () => {
    __resetAntigravityVersionCache();
    delete process.env['ANTIGRAVITY_VERSION'];
    const fetcher = vi.fn(async () => new Response('garbage', { status: 500 }));
    await expect(ensureAntigravityVersion(fetcher)).resolves.toBeUndefined();
    expect(getAntigravityUserAgent()).toContain(`antigravity/hub/${DEFAULT_ANTIGRAVITY_VERSION}`);
    __resetAntigravityVersionCache();
  });

  it('expires the successful version cache after one hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    __resetAntigravityVersionCache();
    delete process.env['ANTIGRAVITY_VERSION'];
    const fetcher = vi.fn(async () => new Response('version: 9.9.9'));
    await ensureAntigravityVersion(fetcher);
    await ensureAntigravityVersion(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-09-08T01:00:01Z'));
    await ensureAntigravityVersion(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('identity overrides also suppress version probing', async () => {
    delete process.env['ANTIGRAVITY_VERSION'];
    vi.stubEnv('ANTIGRAVITY_OS', 'linux');
    const fetcher = vi.fn();
    await ensureAntigravityVersion(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('env override: ANTIGRAVITY_VERSION skips the probe entirely', async () => {
    __resetAntigravityVersionCache();
    process.env['ANTIGRAVITY_VERSION'] = '7.7.7';
    const fetcher = vi.fn(async () => {
      throw new Error('must not be called');
    });
    await ensureAntigravityVersion(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(getAntigravityUserAgent()).toContain('antigravity/hub/7.7.7');
    delete process.env['ANTIGRAVITY_VERSION'];
    __resetAntigravityVersionCache();
  });
});

describe('sandbox failover switch (design D5)', () => {
  const primaryUrl = `${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

  it('classifies retryable failures (transport/429/5xx/unavailable-400-404)', () => {
    expect(isAntigravityRetryableFailure(null)).toBe(true);
    expect(isAntigravityRetryableFailure(429)).toBe(true);
    expect(isAntigravityRetryableFailure(503)).toBe(true);
    expect(isAntigravityRetryableFailure(400, 'Requested model is currently unavailable')).toBe(true);
    expect(isAntigravityRetryableFailure(404, 'requested entity was not found')).toBe(true);
    expect(isAntigravityRetryableFailure(400, 'invalid argument')).toBe(false);
    expect(isAntigravityRetryableFailure(401)).toBe(false);
  });

  it('retries a Responses fetch only once and honors cancellation and disabled failover', async () => {
    setAntigravitySandboxFailover(true);
    const send = vi.fn(async () => new Response('', { status: 503 }));
    expect((await fetchWithAntigravityFailover(primaryUrl, send)).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toContain('daily-cloudcode-pa.sandbox.googleapis.com');
    setAntigravitySandboxFailover(false);
    send.mockClear();
    await fetchWithAntigravityFailover(primaryUrl, send);
    expect(send).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    send.mockClear();
    await expect(fetchWithAntigravityFailover(primaryUrl, send, controller.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    __resetAntigravityFailoverState();
  });

  it('OFF (default): NEVER switches — the original error semantics surface', () => {
    __resetAntigravityFailoverState();
    expect(maybeAntigravityFailoverUrl(primaryUrl, 503)).toBeNull();
    expect(maybeAntigravityFailoverUrl(primaryUrl, 429)).toBeNull();
  });

  it('ON: a retryable primary failure swaps to the sandbox URL (one direction)', () => {
    setAntigravitySandboxFailover(true);
    expect(maybeAntigravityFailoverUrl(primaryUrl, 503)).toBe(
      'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    );
    // A non-retryable failure does not switch.
    expect(maybeAntigravityFailoverUrl(primaryUrl, 401)).toBeNull();
    // A SANDBOX failure never fails back to production.
    expect(
      maybeAntigravityFailoverUrl(
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
        503,
      ),
    ).toBeNull();
    __resetAntigravityFailoverState();
  });
});

describe('gemini byte-equivalence of the SHARED components (re-run pin)', () => {
  it('the shared .response peeling behaves identically for both envelopes', () => {
    expect(peelCcaResponseEnvelope({ response: { candidates: [] } })).toEqual({ candidates: [] });
    expect(peelCcaResponseEnvelope({ already: 'unwrapped' })).toEqual({ already: 'unwrapped' });
    expect(peelCcaResponseEnvelope('non-object')).toBe('non-object');
  });

  it('the antigravity URL uses the SAME colon-method construction as gemini', () => {
    // Same version segment + method shape; only the BASE differs (daily- prefix).
    expect(buildAntigravityUrl(false).endsWith('/v1internal:generateContent')).toBe(true);
    expect(buildAntigravityUrl(true).endsWith('/v1internal:streamGenerateContent?alt=sse')).toBe(true);
    expect(buildAntigravityUrl(false).startsWith('https://daily-cloudcode-pa.googleapis.com')).toBe(true);
  });
});
