/**
 * GeminiCodeAssistTransformer — Google **Code Assist** envelope for the gemini
 * SUBSCRIPTION path (`cloudcode-pa.googleapis.com`).
 *
 * The gemini-CLI OAuth subscription tokens are minted for Google's internal
 * Code Assist API, NOT the public Gemini API. Code Assist wraps the standard
 * `generateContent` body in a project/session envelope and uses a different
 * URL shape (version segment + colon-method, NO `/models/<model>` path). This
 * transformer does ONLY that envelope work and DELEGATES all inner encoding /
 * parsing to the existing gemini utils (`buildRequestBody`,
 * `transformResponseOut`) so the two stay in lock-step.
 *
 * Envelope spec — verified against gemini-cli
 * `packages/core/src/code_assist/{server,converter,setup,types}.ts`:
 *
 *   Request (CAGenerateContentRequest):
 *     {
 *       model: "gemini-2.5-pro",        // TOP-LEVEL (NOT inside `request`)
 *       project: <resolved project id>, // TOP-LEVEL, undefined for fresh free-tier
 *       user_prompt_id: <per-turn id>,  // TOP-LEVEL, snake_case
 *       request: { contents, systemInstruction, tools, toolConfig,
 *                  generationConfig, ... }   // standard public-Gemini body
 *     }
 *
 *   URL: `${base}/${version}:${method}` — colon AFTER the version segment, NO
 *        `/models/<model>` (model lives in the body). `base` defaults to
 *        `https://cloudcode-pa.googleapis.com`, `version` to `v1internal`;
 *        both overridable via `CODE_ASSIST_ENDPOINT` / `CODE_ASSIST_API_VERSION`.
 *        Stream method `streamGenerateContent?alt=sse`, non-stream
 *        `generateContent`.
 *
 *   Auth: `Authorization: Bearer <oauth access token>` ONLY (no x-goog-api-key).
 *         The actual Bearer is injected downstream by the subscription
 *         `OAuthBearerAuthStrategy`; this transformer just clears x-goog-api-key.
 *
 *   Response (CaGenerateContentResponse): the standard `GenerateContentResponse`
 *     is nested under a top-level `response` key. We PEEL `.response` from the
 *     body / each SSE `data:` chunk, then hand the unwrapped stream/JSON to the
 *     existing gemini response parser (`transformResponseOut`).
 *
 * @module transformer/transformers/GeminiCodeAssistTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
} from '../types';

import { buildCcaMethodUrl, unwrapCcaResponse } from './ccaEnvelope';
import { transformResponseIn } from './utils/gemini.response-in';
import { transformResponseOut } from './utils/gemini.stream';
import { buildRequestBody, transformRequestOut as toUnifiedRequest } from './utils/gemini.util';

/** Default Code Assist base + version (overridable via env). */
const DEFAULT_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_CODE_ASSIST_API_VERSION = 'v1internal';

/** Resolve the Code Assist base URL (env override allowed). */
export function resolveCodeAssistEndpoint(): string {
  return (process.env.CODE_ASSIST_ENDPOINT || DEFAULT_CODE_ASSIST_ENDPOINT).replace(/\/+$/, '');
}

/** Resolve the Code Assist API version segment (env override allowed). */
export function resolveCodeAssistApiVersion(): string {
  return process.env.CODE_ASSIST_API_VERSION || DEFAULT_CODE_ASSIST_API_VERSION;
}

/** Gemini CLI client version stamped into the masquerade UA (env override). */
const DEFAULT_GEMINI_CLI_VERSION = '0.46.0';

/**
 * `GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; terminal)` — the exact User-Agent
 * shape the official CLI (v0.35+) sends; the Code Assist backend keys rate
 * limits on it. `GEMINI_CLI_VERSION` overrides the pinned version.
 */
export function getGeminiCliUserAgent(modelId = 'gemini-3.1-pro-preview'): string {
  const version = process.env.GEMINI_CLI_VERSION || DEFAULT_GEMINI_CLI_VERSION;
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

/** The static client-identity headers every Code Assist request carries. */
export function getGeminiCliIdentityHeaders(modelId?: string): Record<string, string> {
  return {
    'User-Agent': getGeminiCliUserAgent(modelId),
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
  };
}

/**
 * Build the Code Assist URL (shared colon-method construction, see
 * `ccaEnvelope.buildCcaMethodUrl`): `${base}/${version}:${method}`.
 * NOTE: no `/models/<model>` segment — the model goes in the body.
 */
export function buildCodeAssistUrl(stream: boolean): string {
  return buildCcaMethodUrl(resolveCodeAssistEndpoint(), resolveCodeAssistApiVersion(), stream);
}

/** Generate a per-turn `user_prompt_id` (matches gemini-cli's uuid usage). */
function generateUserPromptId(): string {
  // Prefer crypto.randomUUID when present; fall back to a cheap unique id.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `omnicross-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// The `.response` envelope peeling (SSE + JSON) lives in the SHARED
// `ccaEnvelope` module (extracted verbatim by antigravity-subscription-
// provider D2) so the gemini-cli and antigravity Code Assist transformers stay
// in lock-step. Re-exported for existing importers.

/**
 * GeminiCodeAssistTransformer — extends `GeminiTransformer`'s inner encoding by
 * wrapping it in the Code Assist envelope. Registered under
 * `gemini-code-assist` so `getTransformer('gemini-code-assist')` resolves.
 */
export class GeminiCodeAssistTransformer implements Transformer {
  static TransformerName = 'gemini-code-assist';
  name = 'gemini-code-assist';
  logger?: TransformerLogger;

  /** Code Assist has no fixed `/models/:modelAndAction` endpoint pattern — the
   *  URL is built per-request in `transformRequestIn`. Left undefined so the
   *  TransformerService does NOT treat this as an endpoint (reverse) transformer. */
  endPoint = undefined;

  /**
   * unified → Code Assist envelope.
   *
   * Builds the inner public-Gemini body via the shared `buildRequestBody`, then
   * wraps it as `{ model, project, user_prompt_id, request: <inner> }` and sets
   * the Code Assist URL + Bearer-only headers.
   *
   * The resolved Code Assist `project` is threaded in via `provider.geminiProject`
   * (stashed by the subscription dispatch seam — see SubscriptionDispatcher /
   * openaiResponsesIngress). `undefined` is the valid fresh free-tier value.
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext,
  ): Promise<Record<string, unknown>> {
    const inner = buildRequestBody(request, provider);

    const envelope: Record<string, unknown> = {
      model: request.model,
      project: provider.geminiProject,
      user_prompt_id: generateUserPromptId(),
      request: inner,
    };

    const url = buildCodeAssistUrl(Boolean(request.stream));

    // Code Assist authenticates with Bearer ONLY — clear any x-goog-api-key the
    // public-Gemini path would have set. The actual Bearer is injected by the
    // subscription OAuthBearerAuthStrategy after the chain runs. The GeminiCLI
    // identity pair rides every request too — the backend keys rate limits on
    // the client UA, and unstyled traffic gets the anonymous tier.
    const headers: Record<string, string | undefined> = {
      'x-goog-api-key': undefined,
      'X-Goog-Api-Key': undefined,
      ...getGeminiCliIdentityHeaders(request.model),
    };

    return {
      body: envelope,
      config: { url, headers },
    };
  }

  /**
   * Code Assist request → unified (endpoint-decode parity with GeminiTransformer).
   * Peels the top-level `request` envelope first, then delegates to the shared
   * gemini request decoder. Not used on the subscription dispatch path (the
   * endpoint transformer there is Anthropic/OpenAI-Response), but provided for
   * completeness so this transformer is a drop-in for the gemini one.
   */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext,
  ): Promise<UnifiedChatRequest> {
    const r = request as Record<string, unknown>;
    const inner = (r && typeof r === 'object' && 'request' in r ? r.request : r) as Record<
      string,
      unknown
    >;
    // Preserve the top-level `model` if the inner body omits it.
    if (inner && typeof inner === 'object' && !('model' in inner) && 'model' in r) {
      inner.model = r.model;
    }
    return toUnifiedRequest(inner);
  }

  /**
   * Code Assist response → OpenAI-compatible. PEEL the `.response` envelope from
   * the body / each SSE chunk, then DELEGATE to the existing gemini parser.
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext,
  ): Promise<Response> {
    const unwrapped = await unwrapCcaResponse(response);
    return transformResponseOut(unwrapped, this.name, this.logger);
  }

  /**
   * OpenAI-compatible response → Code Assist (endpoint-encode parity). Re-wraps
   * the standard gemini response under the top-level `response` key after the
   * shared gemini encoder produces a public-Gemini body. Symmetric with
   * `transformResponseOut`'s peel.
   */
  async transformResponseIn(
    response: Response,
    _context?: TransformerContext,
  ): Promise<Response> {
    const geminiResponse = await transformResponseIn(response, this.logger);
    const contentType = geminiResponse.headers.get('Content-Type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Streaming endpoint-encode is not exercised on the subscription path;
      // return the gemini stream unchanged (wrapping each chunk is unnecessary
      // for the dispatch direction we wire).
      return geminiResponse;
    }
    const data = await geminiResponse.json().catch(() => null);
    return new Response(JSON.stringify({ response: data }), {
      status: geminiResponse.status,
      statusText: geminiResponse.statusText,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
