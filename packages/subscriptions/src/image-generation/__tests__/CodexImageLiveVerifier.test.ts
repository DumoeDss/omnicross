import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryImageAsset } from '@omnicross/core/image-generation';
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
import { createCodexImageLiveVerifier } from '../CodexImageLiveVerifier';

const VALID_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVR4nGP4z8DQAMIADv0C/528KS0AAAAASUVORK5CYII=';
const RAW_ACCOUNT_ID = 'RAW_ACCOUNT_ID_TRANSIENT_SENTINEL';

function auth(): AuthStrategy & {
  applyHeaders: ReturnType<typeof vi.fn>;
  onUnauthorized: ReturnType<typeof vi.fn>;
} {
  const applyHeaders = vi.fn(async (
    headers: Record<string, string>,
    hints?: Parameters<AuthStrategy['applyHeaders']>[1],
  ) => {
    headers.Authorization = 'Bearer CREDENTIAL_SECRET_SENTINEL';
    hints?.reportSelection?.(RAW_ACCOUNT_ID, true);
  });
  const onUnauthorized = vi.fn(async () => true);
  return {
    kind: 'oauth-bearer',
    providerId: 'codex',
    applyHeaders,
    onUnauthorized,
    async describeStatus() { return { providerId: 'codex', ok: true }; },
  };
}

async function waitForTraceRecords(
  path: string,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
      if (lines.length >= count) {
        try {
          return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        } catch { /* retry */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for verifier trace metadata.');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetUpstreamProxyForTests();
  __resetUpstreamTraceForTests();
});

describe('CodexImageLiveVerifier', () => {
  it('honors strict versus pool fallback for an unavailable preferred binding', async () => {
    const applyHeaders = vi.fn(async (
      headers: Record<string, string>,
      hints?: Parameters<AuthStrategy['applyHeaders']>[1],
    ) => {
      if (hints?.preferredAccountId === 'unavailable' &&
        hints.boundAccountFallbackPolicy !== 'pool') {
        throw new Error('preferred account unavailable');
      }
      headers.Authorization = 'Bearer CREDENTIAL_SECRET_SENTINEL';
      hints?.reportSelection?.('healthy-sibling', true);
    });
    const strategy: AuthStrategy = {
      kind: 'oauth-bearer',
      providerId: 'codex',
      applyHeaders,
      async onUnauthorized() { return false; },
      async describeStatus() { return { providerId: 'codex', ok: true }; },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{ type: 'image_generation_call', status: 'completed', result: VALID_PNG }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const verifier = createCodexImageLiveVerifier({ authStrategy: strategy });

    await expect(verifier.verify({
      signal: new AbortController().signal,
      preferredAccountId: 'unavailable',
      boundAccountFallbackPolicy: 'strict',
    })).rejects.toMatchObject({ code: 'image_generation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(verifier.verify({
      signal: new AbortController().signal,
      preferredAccountId: 'unavailable',
      boundAccountFallbackPolicy: 'pool',
    })).resolves.toMatchObject({ accountId: 'healthy-sibling' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(applyHeaders.mock.calls.map((call) => call[1]?.boundAccountFallbackPolicy))
      .toEqual(['strict', 'pool']);
  });

  it('verifies a reference edit with the generated artifact before returning evidence', async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return url.endsWith('/images/edits')
        ? new Response(JSON.stringify({ created: 2, data: [{ b64_json: VALID_PNG }] }), { status: 200 })
        : new Response(JSON.stringify({
            output: [{ type: 'image_generation_call', status: 'completed', result: VALID_PNG }],
          }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const verifier = createCodexImageLiveVerifier({ authStrategy: auth() });
    await expect(verifier.verify({ signal: new AbortController().signal }))
      .resolves.toMatchObject({ accountId: RAW_ACCOUNT_ID, model: 'gpt-image-2' });

    expect(requests.map((item) => item.url)).toEqual([
      'https://chatgpt.com/backend-api/codex/responses',
      'https://chatgpt.com/backend-api/codex/images/edits',
    ]);
    expect(requests[1]?.headers.get('accept')).toBe('application/json');
    expect(requests[1]?.body).toEqual({
      images: [{ image_url: `data:image/png;base64,${VALID_PNG}` }],
      prompt: 'A single solid black square.',
      background: 'opaque',
      model: 'gpt-image-2',
      quality: 'low',
      size: 'auto',
    });
  });

  it('makes two redacted minimal PNG requests, returns narrow evidence, and destroys both artifacts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnicross-image-live-verifier-'));
    const tracePath = join(directory, 'trace.jsonl');
    setUpstreamTracePath(tracePath);
    let proxyAccount = '';
    setUpstreamProxyResolver((context) => {
      proxyAccount = context.accountId ?? '';
      return undefined;
    });
    const dispose = vi.spyOn(InMemoryImageAsset.prototype, 'dispose');
    const candidateRequests: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      candidateRequests.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      if (url.endsWith('/images/edits')) {
        return new Response(JSON.stringify({
          created: 2,
          data: [{ b64_json: VALID_PNG }],
        }), { status: 200 });
      }
      const sse = [
        `data: ${JSON.stringify({ partial_image_index: 0, partial_image_b64: VALID_PNG.slice(0, -4) })}`,
        `data: ${JSON.stringify({ partial_image_index: 0, partial_image_b64: VALID_PNG })}`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            output: [{
              type: 'image_generation_call',
              revised_prompt: 'REVISED_PROMPT_SECRET_SENTINEL',
            }],
            usage: { total_tokens: 7, generated_images: 1 },
          },
        })}`,
        'data: [DONE]',
        '',
      ].join('\n\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const verifier = createCodexImageLiveVerifier({ authStrategy: auth() });
    const result = await verifier.verify({ signal: new AbortController().signal });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyAccount).toBe(RAW_ACCOUNT_ID);
    expect(candidateRequests[0]?.headers.get('authorization')).toBe('Bearer CREDENTIAL_SECRET_SENTINEL');
    expect(candidateRequests[0]?.headers.get('accept')).toBe('text/event-stream');
    expect(candidateRequests[0]?.headers.get('originator')).toBe('codex_cli_rs');
    expect(candidateRequests[0]?.headers.get('user-agent')).toMatch(/^codex_cli_rs\//u);
    expect(candidateRequests[0]?.headers.get('version')).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(JSON.parse(candidateRequests[0]!.body)).toMatchObject({
      instructions: '',
      model: 'gpt-5.6-luna',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'A single solid black square.' }],
      }],
      stream: true,
      store: false,
      tools: [{
        type: 'image_generation',
        action: 'generate',
        model: 'gpt-image-2',
        quality: 'low',
        output_format: 'png',
      }],
    });
    expect(result).toEqual({
      accountId: RAW_ACCOUNT_ID,
      model: 'gpt-image-2',
      request: {
        action: 'generate',
        n: 1,
        quality: 'low',
        size: 'auto',
        background: 'opaque',
        outputFormat: 'png',
        moderation: 'auto',
        stream: false,
        partialImages: 0,
      },
      responseFields: { usage: true, revisedPrompt: true },
    });
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain('A single solid black square.');
    expect(serializedResult).not.toContain('REVISED_PROMPT_SECRET_SENTINEL');
    expect(serializedResult).not.toContain(VALID_PNG);
    expect(serializedResult).not.toContain('CREDENTIAL_SECRET_SENTINEL');
    expect(candidateRequests[1]?.headers.get('accept')).toBe('application/json');
    expect(dispose).toHaveBeenCalledTimes(2);

    const traces = await waitForTraceRecords(tracePath, 2);
    for (const trace of traces) {
      expect(trace.requestBody).toBe(REDACTED_BODY);
      expect(trace.responseBody).toBe(REDACTED_BODY);
      expect(trace.accountId).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    const serializedTrace = JSON.stringify(traces);
    expect(serializedTrace).not.toContain(RAW_ACCOUNT_ID);
    expect(serializedTrace).not.toContain('CREDENTIAL_SECRET_SENTINEL');
    expect(serializedTrace).not.toContain('REVISED_PROMPT_SECRET_SENTINEL');
    expect(serializedTrace).not.toContain(VALID_PNG);
    rmSync(directory, { recursive: true, force: true });
  });

  it('does not retry an unsuccessful consuming verification request', async () => {
    const strategy = auth();
    const fetchMock = vi.fn(async () => new Response(
      '{"error":{"code":"auth","detail":"SECRET_RESPONSE_BODY"}}',
      { status: 401 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const verifier = createCodexImageLiveVerifier({ authStrategy: strategy });
    await expect(verifier.verify({ signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'upstream_auth_required' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(strategy.onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps strict decoding failure safely after exactly one request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        status: 'completed',
        result: '%%%INVALID_BASE64_SECRET_SENTINEL%%%',
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const verifier = createCodexImageLiveVerifier({ authStrategy: auth() });
    await expect(verifier.verify({ signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'upstream_protocol_changed' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('enforces its deadline and caller cancellation without an extra request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const timed = createCodexImageLiveVerifier({ authStrategy: auth(), generationTimeoutMs: 50 });
    const timeoutResult = timed.verify({ signal: new AbortController().signal });
    const timeoutExpectation = expect(timeoutResult)
      .rejects.toMatchObject({ code: 'image_generation_timeout' });
    await vi.advanceTimersByTimeAsync(50);
    await timeoutExpectation;
    expect(fetchMock).toHaveBeenCalledOnce();

    const cancelledController = new AbortController();
    cancelledController.abort(new Error('caller cancelled'));
    const cancelled = createCodexImageLiveVerifier({ authStrategy: auth(), generationTimeoutMs: 50 });
    await expect(cancelled.verify({ signal: cancelledController.signal }))
      .rejects.toMatchObject({ code: 'request_cancelled' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
