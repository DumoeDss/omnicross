import { describe, expect, it, vi } from 'vitest';
import { ImageOrchestrator, ImageProviderRegistry } from '@omnicross/core/image-generation';
import { createCodexSubscriptionImageProvider } from '../CodexSubscriptionImageProvider';
import { ImageGenerationError, imageGenerationErrorFromPublic, serializeImageGenerationError } from '@omnicross/core/image-generation';
import { mapCandidateCodexImageFailure } from '../privateWireErrors';
import { parseCandidateCodexImageResponse, readCandidateCodexImageResponseBody } from '../privateWireResponse';

describe('safe image failure diagnostics', () => {
  it('carries provider parsing evidence through the orchestrator and terminal telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET_BODY', { status: 200 })));
    try {
      const provider = createCodexSubscriptionImageProvider({ authStrategy: {
        kind: 'oauth-bearer', providerId: 'codex',
        async applyHeaders(headers, hints) { headers.Authorization = 'Bearer SECRET_TOKEN'; hints?.reportSelection?.('test-account', true); },
        async onUnauthorized() { return false; },
        async describeStatus() { return { providerId: 'codex', ok: true }; },
      } });
      const record = vi.fn();
      const orchestrator = new ImageOrchestrator({ registry: new ImageProviderRegistry([provider]), telemetrySink: { record } });
      const events = [];
      for await (const event of orchestrator.run({ action: 'generate', model: 'gpt-image-2', prompt: 'SECRET_PROMPT', n: 1,
        quality: 'auto', size: { kind: 'auto' }, background: 'auto', outputFormat: 'png', moderation: 'auto', stream: false, partialImages: 0 },
        { requestId: 'diagnostic-test', tenantId: 'test', signal: new AbortController().signal }, { providerId: provider.id })) events.push(event);
      const failed = events.find(event => event.type === 'failed');
      expect(failed).toMatchObject({ error: { diagnostic: { phase: 'response-shape', reason: 'invalid-shape' } } });
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]?.[0]).toMatchObject({ requestId: 'diagnostic-test', terminal: 'failed', diagnostic: { phase: 'response-shape', reason: 'invalid-shape' } });
      expect(JSON.stringify(record.mock.calls)).not.toContain('SECRET');
    } finally { vi.unstubAllGlobals(); }
  });
  it('distinguishes rejection, body, schema, base64, container and decode without content', async () => {
    const failures: Array<[() => unknown, string]> = [
      [() => { throw mapCandidateCodexImageFailure(new Response('', { status: 422 }), 'secret-token'); }, 'http-rejected'],
      [() => readCandidateCodexImageResponseBody(new Response('secret-token', { headers: { 'content-length': '70000001' } })), 'body-limit'],
      [() => readCandidateCodexImageResponseBody(new Response(new Uint8Array([255]))), 'body-read-failed'],
      [() => parseCandidateCodexImageResponse('secret-token', 1, 'png'), 'invalid-shape'],
      [() => parseCandidateCodexImageResponse(JSON.stringify({ data: [{ b64_json: 'secret-token' }] }), 1, 'png'), 'invalid-base64'],
      [() => parseCandidateCodexImageResponse(JSON.stringify({ data: [{ b64_json: Buffer.from('secret-token').toString('base64') }] }), 1, 'png'), 'incomplete-container'],
      [() => parseCandidateCodexImageResponse(JSON.stringify({ data: [{ b64_json: Buffer.from([255,216,255,217]).toString('base64') }] }), 1, 'jpeg'), 'invalid-image'],
    ];
    for (const [run, reason] of failures) {
      try { await run(); throw new Error('fixture should fail'); } catch (error) {
        expect(error).toBeInstanceOf(ImageGenerationError);
        if (!(error instanceof ImageGenerationError)) throw error;
        const serialized = serializeImageGenerationError(error);
        expect(serialized.diagnostic?.reason).toBe(reason);
        expect(JSON.stringify(serialized)).not.toContain('secret-token');
        expect(imageGenerationErrorFromPublic(serialized).diagnostic).toEqual(serialized.diagnostic);
      }
    }
  });
  it('rebuilds untrusted diagnostics through the whitelist and ignores content fields', () => {
    const value = { code: 'upstream_protocol_changed', diagnostic: {
      phase: 'response-body', reason: 'body-limit', upstreamStatus: 200, observedBytes: 42,
      prompt: 'secret-token', url: 'https://private.invalid', headers: { Authorization: 'secret-token' },
    } };
    const output = serializeImageGenerationError(imageGenerationErrorFromPublic(value));
    expect(output.diagnostic).toEqual({ phase: 'response-body', reason: 'body-limit', upstreamStatus: 200, observedBytes: 42 });
    expect(JSON.stringify(output)).not.toMatch(/secret-token|private.invalid|Authorization|prompt/);
    value.diagnostic.reason = 'secret-token';
    expect(imageGenerationErrorFromPublic(value).diagnostic).toBeUndefined();
  });
});
