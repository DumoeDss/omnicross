/**
 * Shared helpers for the ProviderProxy ingress parsers.
 *
 * All ingress parsers (Anthropic Messages, OpenAI Responses, OpenAI Chat,
 * Gemini generateContent) read the full request body, share one stateless
 * `TransformerChainExecutor`, and relay an already-wire-shaped `Response` (JSON
 * or SSE) back to the http `res`. This module owns ONLY that common plumbing so
 * each parser stays under the size cap and the relay shape is identical across
 * ingresses (parity with the host's codex relay / stream manager). It also
 * vends the lazy-singleton endpoint transformers
 * (Responses, Gemini, Anthropic) the factory-less BYO paths reuse.
 *
 * @module provider-proxy/ingress/providerProxyShared
 */

import type http from 'node:http';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import { resolveProviderEndpoint } from '../../completion';
import { TransformerChainExecutor } from '../../transformer';
import { AnthropicTransformer } from '../../transformer/transformers/AnthropicTransformer';
import { GeminiTransformer } from '../../transformer/transformers/GeminiTransformer';
import { OpenAIResponseTransformer } from '../../transformer/transformers/OpenAIResponseTransformer';
import type { Transformer } from '../../transformer/types';
import type { ProviderProxyDeps } from '../types';

// Singleton executor — stateless, reusable (same pattern as the host's
// request handlers).
let sharedExecutor: TransformerChainExecutor | null = null;
export function getSharedExecutor(): TransformerChainExecutor {
  if (!sharedExecutor) {
    sharedExecutor = new TransformerChainExecutor();
  }
  return sharedExecutor;
}

// Shared endpoint transformer instance (stateless). The Responses one decodes
// the OpenAI Responses wire AND (subscription codex) re-encodes Unified →
// Responses for the chatgpt upstream.
let sharedResponses: Transformer | null = null;
export function getResponsesEndpointTransformer(): Transformer {
  if (!sharedResponses) sharedResponses = new OpenAIResponseTransformer();
  return sharedResponses;
}

// Shared Anthropic endpoint transformer instance (stateless). As an endpoint
// transformer it decodes the Anthropic `/v1/messages` wire → Unified
// (`transformRequestOut`) on the request side AND re-encodes Unified → Anthropic
// wire (`transformResponseIn`, which auto-detects `text/event-stream` and pipes
// through `convertOpenAIStreamToAnthropic`) on the response side, so a BYO
// `/v1/messages` caller gets an Anthropic-shaped response regardless of the
// target provider's wire format. Used by the built-in factory-less Anthropic BYO
// path (`anthropicMessagesByo.ts`); the factory-PRESENT delegation branch keeps
// using the host handler's own `AnthropicTransformer` instance.
let sharedAnthropic: Transformer | null = null;
export function getAnthropicEndpointTransformer(): Transformer {
  if (!sharedAnthropic) sharedAnthropic = new AnthropicTransformer();
  return sharedAnthropic;
}

// Shared Gemini endpoint transformer instance (stateless). As an endpoint
// transformer it decodes the Gemini `generateContent` wire → Unified
// (`transformRequestOut`) on the request side AND re-encodes Unified → Gemini
// wire (`transformResponseIn`) on the response side, so the gemini-CLI gets a
// Gemini-shaped response regardless of the target provider's wire format.
let sharedGemini: Transformer | null = null;
export function getGeminiEndpointTransformer(): Transformer {
  if (!sharedGemini) sharedGemini = new GeminiTransformer();
  return sharedGemini;
}

/** Read the full request body from an IncomingMessage. */
export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Relay an already-wire-shaped `Response` to the http `res`.
 * - `text/event-stream` (or `isStream`): pipe the ReadableStream chunk-by-chunk.
 * - else: read the JSON text and write it once, returning it so the caller can
 *   tap usage. Mirrors the host's codex relay.
 *
 * @returns the JSON body text for non-stream responses, else `null`.
 */
export async function relayResponse(
  res: http.ServerResponse,
  providerResponse: Response,
  isStream: boolean,
): Promise<string | null> {
  const contentType = providerResponse.headers.get('Content-Type') ?? '';
  const status =
    providerResponse.status && providerResponse.status >= 100 ? providerResponse.status : 200;

  if (isStream || contentType.includes('text/event-stream')) {
    res.writeHead(status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (!providerResponse.body) {
      res.end();
      return null;
    }
    const reader = providerResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
      res.end();
    }
    return null;
  }

  const bodyText = await providerResponse.text();
  res.writeHead(status, { 'Content-Type': contentType.includes('json') ? contentType : 'application/json' });
  res.end(bodyText);
  return bodyText;
}

/** Write a JSON error response if the headers have not been sent. */
export function writeError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: 'provider_proxy_error', message } }));
}

/** Resolve an `$ENV_VAR` reference or return the literal key. */
function resolveApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.startsWith('$')) {
    return process.env[apiKey.slice(1)] || '';
  }
  return apiKey;
}

/**
 * Resolve the FIRST-CHOICE BYO request key for a `buildByoPlan`, threading the
 * ApiKeyPool through TWO gates so 429/529/401/403 failover actually fires on the
 * outbound serving path (omnicross-daemon-parity-poolseam, design D2(b)).
 *
 * MIRRORS the host engine adapter's `resolveApiKeyForProvider` (the reference impl whose
 * pool failover already works internally):
 *   - pool present AND a (synthesized outbound) sessionId present →
 *     `getKeyForSession(providerId, sessionId)`. This SEEDS `sessionBindings`
 *     with the chosen key AND returns that same key, so it becomes the first
 *     request's key. WHY both gates matter: `LlmConfigProviderAuth.onResult`
 *     short-circuits on a null sessionId (gate 1); even with a sessionId,
 *     `ApiKeyPoolService.reportError` short-circuits when there is no binding for
 *     that session (gate 2) — and the binding only exists once `getKeyForSession`
 *     has run. The first request MUST use the bound key (not the row's `apiKey`)
 *     so the key the pool cools/rebinds on error === the key actually used.
 *   - otherwise (pool null, no sessionId, or the pool returns empty) → fall back
 *     to `resolveProviderEndpoint(provider).apiKey` with the same `$ENV`
 *     resolution the ingresses' own `resolveApiKey` used → BYTE-IDENTICAL to the
 *     pre-seam path. (Single-key pools also short-circuit inside
 *     `getKeyForSession` → `selectWeightedRoundRobin`'s `length===1`, returning
 *     the one key, so the wire key is unchanged there too.)
 *
 * `$ENV` semantics MUST match the ingresses' original `resolveApiKey`
 * (`$VAR → process.env[VAR] ?? ''`, else literal). The pool returns an
 * already-`resolveKey`-resolved string (its loader passes the host resolver),
 * so the pool branch needs no further `$ENV` expansion.
 */
export async function resolvePoolBoundKey(
  deps: ProviderProxyDeps,
  providerId: string,
  provider: LLMProvider,
  sessionId: string | null,
): Promise<string> {
  if (deps.apiKeyPool && sessionId) {
    const poolKey = await deps.apiKeyPool.getKeyForSession(providerId, sessionId);
    if (poolKey) return poolKey;
  }
  return resolveApiKey(resolveProviderEndpoint(provider).apiKey);
}
