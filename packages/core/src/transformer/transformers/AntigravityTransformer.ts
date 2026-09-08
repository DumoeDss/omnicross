/**
 * AntigravityTransformer — the Antigravity subscription's Cloud Code Assist
 * envelope (`daily-cloudcode-pa.googleapis.com`, antigravity-subscription-
 * provider design D2/D3/D4).
 *
 * Antigravity shares the gemini-cli CCA wire's INNER body (the standard
 * `generateContent` request nested under `request`, the same SSE `.response`
 * peeling) — so this transformer consumes the SAME shared components as
 * `GeminiCodeAssistTransformer` (`ccaEnvelope` + the gemini request/response
 * utils) and layers ONLY the antigravity-specific OUTER differences on top:
 *
 *   Request (antigravity envelope):
 *     {
 *       project: <resolved project id>,        // REQUIRED (always resolved)
 *       model: <WIRE model id>,                // post effort/thinking variant routing
 *       requestId: "agent/<uuid>/<ts>/<uuid>/<step>",
 *       userAgent: "antigravity",
 *       requestType: "agent",
 *       request: {                             // standard generateContent body
 *         contents, systemInstruction (role "user"), tools, toolConfig,
 *         generationConfig, sessionId, labels
 *       }
 *     }
 *
 *   Per-family decoration (ONE dispatch profile — the family differences live
 *   HERE, not in per-model transformer selection; design D3):
 *     - Gemini / gpt-oss: effort variant id routing (`gemini-3.5-flash`+low →
 *       `gemini-3.5-flash-extra-low` etc.), per-wire-id `maxOutputTokens`
 *       profile clamp, forced-tool directive injection (a STATIC pinned asset),
 *       `labels.model_enum` telemetry token, VALIDATED tool mode default.
 *     - Claude: thinking variant as an INDEPENDENT wire id, legacy
 *       `parameters` tool schema (NOT `parametersJsonSchema`), the
 *       `anthropic-beta` interleaved-thinking header, NO `model_enum` label,
 *       ALWAYS VALIDATED tool mode.
 *
 *   Masquerade: the antigravity/hub User-Agent (version hot-probed with a
 *       pinned 2.8.0 fallback — `antigravityIdentity`); the auth strategy
 *       re-stamps the same value after the chain, keeping one source.
 *
 *   URL: `${daily-cloudcode-pa}/v1internal:streamGenerateContent?alt=sse`
 *       (the sandbox failover swap is applied by the dispatch retry seam, not
 *       here — the transformer emits the primary endpoint URL).
 *
 * @module transformer/transformers/AntigravityTransformer
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ThinkLevel } from '@omnicross/contracts/completion-types';
import { ANTIGRAVITY_CODE_ASSIST_ENDPOINT } from '../../auth/GeminiCodeAssistProjectResolver';
import { antigravityModelFamily } from '../../pipeline/antigravityQuotaFamily';
import {
  extractReasoningIntent,
  resolveReasoningEffort,
  resolveTargetModelCapabilities,
} from '../reasoning-effort';
import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
} from '../types';

import {
  ensureAntigravityVersion,
  getAntigravityModelWireProfile,
  getAntigravityUserAgent,
  getAntigravityVersion,
} from './antigravityIdentity';
import { buildCcaMethodUrl, unwrapCcaResponse } from './ccaEnvelope';
import { transformResponseOut } from './utils/gemini.stream';
import { buildRequestBody, transformRequestOut as toUnifiedRequest } from './utils/gemini.util';
import { cleanSchemaForCcaLegacyParameters } from './utils/ccaLegacySchema';

/**
 * The forced-tool directive, pinned as a STATIC asset (design D4): a frozen
 * copy of the reference client's instruction (source version 2.8.0). It does
 * NOT follow the hot-probed UA version — a drift between the probe and this
 * pin only logs a hint (see `checkForcedToolAssetDrift`).
 */
export const ANTIGRAVITY_FORCED_TOOL_DIRECTIVE =
  'TOOL-ONLY TURN. This turn accepts a tool call and nothing else; a text reply here is discarded unread and you will be re-prompted. Emit the tool call now.';

/** The version the forced-tool asset above was frozen from. */
export const ANTIGRAVITY_FORCED_TOOL_ASSET_VERSION = '2.8.0';

/** The `anthropic-beta` flag set the Claude family carries on CCA. */
const CLAUDE_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14';

/** Log a drift hint at most once per process. */
let forcedToolDriftLogged = false;

/**
 * When the hot-probed UA version drifts from the forced-tool asset's frozen
 * version, log a hint for manual review (design D4: pin + 人工复查 — the asset
 * NEVER auto-follows the probe).
 */
export function checkForcedToolAssetDrift(currentVersion: string, log?: (message: string) => void): void {
  if (forcedToolDriftLogged || currentVersion === ANTIGRAVITY_FORCED_TOOL_ASSET_VERSION) return;
  forcedToolDriftLogged = true;
  const message =
    `[AntigravityTransformer] UA version ${currentVersion} differs from the frozen ` +
    `forced-tool asset version ${ANTIGRAVITY_FORCED_TOOL_ASSET_VERSION} — review whether the ` +
    `upstream directive changed (the asset does not auto-follow).`;
  (log ?? ((line: string) => console.warn(line)))(message);
}

/**
 * Effort/thinking → wire variant id routes, transcribed from the reference
 * client's collapse table. The WHETHER a route engages is driven by the
 * canonical registry's thinkingLevels (see `resolveWireModelId`); this table
 * only supplies the id mapping. `off` covers effort `none` / absent-with-
 * suppressed-thinking; `default` is the id used when no route matches.
 */
type VariantRoutes = { off?: string; default?: string } & Partial<Record<Exclude<ThinkLevel, 'none'>, string>>;

const ANTIGRAVITY_VARIANT_ROUTES: Readonly<Record<string, VariantRoutes>> = {
  // Gemini ≥3.6 flash (google-level): minimal|low → -low, medium → -medium, high → -high.
  'gemini-3.6-flash': {
    default: 'gemini-3.6-flash-low',
    minimal: 'gemini-3.6-flash-low',
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
  },
  'gemini-3.7-flash': {
    default: 'gemini-3.7-flash-low',
    minimal: 'gemini-3.7-flash-low',
    low: 'gemini-3.7-flash-low',
    medium: 'gemini-3.7-flash-medium',
    high: 'gemini-3.7-flash-high',
  },
  'gemini-3.8-flash': {
    default: 'gemini-3.8-flash-low',
    minimal: 'gemini-3.8-flash-low',
    low: 'gemini-3.8-flash-low',
    medium: 'gemini-3.8-flash-medium',
    high: 'gemini-3.8-flash-high',
  },
  // Gemini 3.5 flash (budget transport; `gemini-3-flash` is its alias):
  // minimal|low → extra-low, medium → -low, high → the agent id.
  'gemini-3.5-flash': {
    default: 'gemini-3.5-flash-extra-low',
    off: 'gemini-3.5-flash-extra-low',
    minimal: 'gemini-3.5-flash-extra-low',
    low: 'gemini-3.5-flash-extra-low',
    medium: 'gemini-3.5-flash-low',
    high: 'gemini-3-flash-agent',
  },
  'gemini-3-flash': {
    default: 'gemini-3.5-flash-extra-low',
    off: 'gemini-3.5-flash-extra-low',
    minimal: 'gemini-3.5-flash-extra-low',
    low: 'gemini-3.5-flash-extra-low',
    medium: 'gemini-3.5-flash-low',
    high: 'gemini-3-flash-agent',
  },
  // Gemini 3.1 pro: low → -low, high → the pro-agent id.
  'gemini-3.1-pro': {
    default: 'gemini-3.1-pro-low',
    off: 'gemini-3.1-pro-low',
    low: 'gemini-3.1-pro-low',
    high: 'gemini-pro-agent',
  },
  // Gemini 3 pro (google-level): low → -low, high → -high.
  'gemini-3-pro': {
    default: 'gemini-3-pro-low',
    off: 'gemini-3-pro-low',
    low: 'gemini-3-pro-low',
    high: 'gemini-3-pro-high',
  },
  // gpt-oss 120b: every effort level rides the -medium wire id.
  'gpt-oss-120b': {
    default: 'gpt-oss-120b-medium',
    minimal: 'gpt-oss-120b-medium',
    low: 'gpt-oss-120b-medium',
    medium: 'gpt-oss-120b-medium',
    high: 'gpt-oss-120b-medium',
  },
  // Claude 4.5: thinking is a separate wire id; off rides the base id.
  'claude-opus-4-5': {
    off: 'claude-opus-4-5',
    minimal: 'claude-opus-4-5-thinking',
    low: 'claude-opus-4-5-thinking',
    medium: 'claude-opus-4-5-thinking',
    high: 'claude-opus-4-5-thinking',
  },
  'claude-sonnet-4-5': {
    off: 'claude-sonnet-4-5',
    minimal: 'claude-sonnet-4-5-thinking',
    low: 'claude-sonnet-4-5-thinking',
    medium: 'claude-sonnet-4-5-thinking',
    high: 'claude-sonnet-4-5-thinking',
  },
  // Claude opus 4.6: the BASE id is retired upstream — every request (off or
  // not) rides the thinking wire id.
  'claude-opus-4-6': {
    default: 'claude-opus-4-6-thinking',
    off: 'claude-opus-4-6-thinking',
    minimal: 'claude-opus-4-6-thinking',
    low: 'claude-opus-4-6-thinking',
    medium: 'claude-opus-4-6-thinking',
    high: 'claude-opus-4-6-thinking',
  },
  // Claude sonnet 4.6: the THINKING variant is retired upstream — always base.
  'claude-sonnet-4-6': {
    default: 'claude-sonnet-4-6',
  },
  // Gemini 2.5 flash/lite: thinking rides the -thinking wire id.
  'gemini-2.5-flash': {
    off: 'gemini-2.5-flash',
    minimal: 'gemini-2.5-flash-thinking',
    low: 'gemini-2.5-flash-thinking',
    medium: 'gemini-2.5-flash-thinking',
    high: 'gemini-2.5-flash-thinking',
  },
  'gemini-2.5-flash-lite': {
    off: 'gemini-2.5-flash-lite',
    minimal: 'gemini-2.5-flash-lite-thinking',
    low: 'gemini-2.5-flash-lite-thinking',
    medium: 'gemini-2.5-flash-lite-thinking',
    high: 'gemini-2.5-flash-lite-thinking',
  },
};

export interface AntigravityWireResolution {
  /** The upstream wire model id (post variant routing). */
  wireModelId: string;
  /** Whether a variant route engaged (the wire id encodes the effort). */
  variantEngaged: boolean;
  /** The negotiated effort level (undefined when the request carried none). */
  effort: ThinkLevel | undefined;
}

/**
 * Resolve the logical model + the request's reasoning intent to the upstream
 * WIRE model id. Effort participation is driven by the CANONICAL registry's
 * `thinkingLevels` (no per-provider negotiation branch): a model with no
 * non-none thinking levels never routes a variant. Exported for tests.
 */
export function resolveAntigravityWireModelId(
  logicalModelId: string,
  request: UnifiedChatRequest,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
): AntigravityWireResolution {
  const routes = ANTIGRAVITY_VARIANT_ROUTES[logicalModelId];
  const intent = extractReasoningIntent({ model: logicalModelId, reasoning: request.reasoning });
  const capabilities = resolveTargetModelCapabilities(logicalModelId, provider);
  const reasoningCapable =
    !!capabilities.thinkingLevels?.some((level: string) => level !== 'none') ||
    capabilities.reasoning === true;

  if (!routes || !intent?.effort) {
    return { wireModelId: routes?.default ?? logicalModelId, variantEngaged: false, effort: intent?.effort };
  }
  // Negotiate the requested effort against the canonical levels (an unsupported
  // effort maps down to a supported one).
  const effort: ThinkLevel =
    intent.effort === 'none'
      ? 'none'
      : reasoningCapable
        ? resolveReasoningEffort(intent.effort, logicalModelId, provider)
        : 'none';
  if (effort === 'none') {
    return { wireModelId: routes.off ?? routes.default ?? logicalModelId, variantEngaged: true, effort };
  }
  const routed: string | undefined = routes[effort];
  if (routed) {
    return { wireModelId: routed, variantEngaged: true, effort };
  }
  return { wireModelId: routes.default ?? logicalModelId, variantEngaged: false, effort };
}

/** The antigravity generateContent endpoint base (primary; failover swaps host). */
export const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_CODE_ASSIST_ENDPOINT;

/** Build the antigravity generateContent URL (colon-method, shared construction). */
export function buildAntigravityUrl(stream: boolean, base: string = ANTIGRAVITY_ENDPOINT): string {
  return buildCcaMethodUrl(base, 'v1internal', stream);
}

const INT63_MASK = (1n << 63n) - 1n;

/** `-<decimal>` signed session id from the first user text's SHA-256 (stable per conversation). */
export function deriveAntigravitySessionId(text: string): string {
  const digest = createHash('sha256').update(text).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return `-${(value & INT63_MASK).toString()}`;
}

/** The first user text in a unified request (the session-id derivation anchor). */
function firstUserText(request: UnifiedChatRequest): string | undefined {
  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const firstText = message.content.find((part) => part.type === 'text');
      return firstText?.text;
    }
    return undefined;
  }
  return undefined;
}

/**
 * AntigravityTransformer — registered under `antigravity`. Consumes the shared
 * CCA envelope components; see the module doc for the wire shape.
 */
export class AntigravityTransformer implements Transformer {
  static TransformerName = 'antigravity';
  name = 'antigravity';
  logger?: TransformerLogger;

  /** The URL is built per-request (colon-method, no fixed endpoint pattern). */
  endPoint = undefined;

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    _context: TransformerContext,
  ): Promise<Record<string, unknown>> {
    // Fire-and-forget the UA version probe — it must never block or fail a path.
    void ensureAntigravityVersion().catch(() => undefined);
    checkForcedToolAssetDrift(getAntigravityVersion(), this.logger?.warn?.bind(this.logger));

    const family = antigravityModelFamily(request.model) ?? 'gemini';
    const { wireModelId, variantEngaged } = resolveAntigravityWireModelId(request.model, request, provider);

    // Inner standard generateContent body via the shared gemini encoder.
    const inner = buildRequestBody({ ...request, model: wireModelId }, provider) as unknown as Record<string, unknown>;

    // generationConfig: per-wire-id maxOutputTokens profile clamp + drop the
    // thinkingConfig when the WIRE ID already encodes the effort (variant route).
    const generationConfig = { ...(inner['generationConfig'] as Record<string, unknown> | undefined ?? {}) };
    if (variantEngaged) {
      delete generationConfig['thinkingConfig'];
    }
    const profile = getAntigravityModelWireProfile(wireModelId);
    if (profile) {
      generationConfig['maxOutputTokens'] = profile.maxOutputTokens;
    }

    // tools: the Claude family rides the LEGACY `parameters` schema (the CCA
    // backend translates it into Anthropic's input_schema; the modern
    // `parametersJsonSchema` form 400s); every other family keeps the standard
    // form the shared encoder produced.
    const tools = inner['tools'] as Array<{ functionDeclarations?: Array<Record<string, unknown>> }> | undefined;
    const decoratedTools =
      family === 'claude' && tools ? tools.map((tool) => legacyParametersTool(tool)) : tools;

    // toolConfig: with tools, the antigravity default is VALIDATED (an explicit
    // NONE wins); a forced choice maps to ANY (+ the directive as a final user
    // turn for the non-Claude families, whose backends drop toolConfig); the
    // Claude family is ALWAYS VALIDATED (even tool-less).
    const contents = inner['contents'] as Array<{ role: string; parts: unknown[] }>;
    let toolConfig = inner['toolConfig'] as
      | { functionCallingConfig: { mode?: string; allowedFunctionNames?: string[] } }
      | undefined;
    let forcedToolInjected = false;
    const hasTools = !!decoratedTools?.some((tool) => (tool.functionDeclarations?.length ?? 0) > 0);
    if (toolConfig?.functionCallingConfig.mode === 'none') {
      toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (toolConfig?.functionCallingConfig.mode === 'any') {
      toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          ...(toolConfig.functionCallingConfig.allowedFunctionNames
            ? { allowedFunctionNames: toolConfig.functionCallingConfig.allowedFunctionNames }
            : {}),
        },
      };
      // The Gemini/gpt-oss backends drop toolConfig: restate the forced choice
      // in the transcript with the pinned directive asset (Claude implements
      // toolConfig natively).
      if (family !== 'claude') {
        contents.push({ role: 'user', parts: [{ text: ANTIGRAVITY_FORCED_TOOL_DIRECTIVE }] });
        forcedToolInjected = true;
      }
    } else if (hasTools || family === 'claude') {
      toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    } else {
      toolConfig = undefined;
    }
    void forcedToolInjected;

    // Session/request envelope identity. Stateless-per-request (the omnicross
    // dispatch creates a transformer per request): sessionId is DERIVED from
    // the conversation's first user text so it is stable per conversation; the
    // step counter mirrors the reference client's monotonic step (assistant
    // turns + 2) and `last_step_index` trails it by one.
    const anchor = firstUserText(request);
    const sessionId = anchor && anchor.trim().length > 0 ? deriveAntigravitySessionId(anchor) : `-${Date.now()}`;
    const trajectoryId = randomUUID();
    const step =
      request.messages.filter((message) => message.role === 'assistant').length + 2;
    const requestId = `agent/${randomUUID()}/${Date.now()}/${trajectoryId}/${step}`;

    const labels: Record<string, string> = {
      last_step_index: String(step - 1),
      // Anthropic ids carry no model_enum token (the backend does not require it).
      ...(family !== 'claude' && profile?.modelEnum !== undefined
        ? { model_enum: profile.modelEnum }
        : {}),
      trajectory_id: trajectoryId,
      used_claude: String(family === 'claude'),
      used_claude_conservative: String(family === 'claude'),
    };

    const innerRequest: Record<string, unknown> = {
      ...inner,
      contents,
      ...(decoratedTools ? { tools: decoratedTools } : {}),
      ...(toolConfig ? { toolConfig } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      sessionId,
      labels,
    };

    const envelope: Record<string, unknown> = {
      project: provider.geminiProject,
      requestId,
      model: wireModelId,
      userAgent: 'antigravity',
      requestType: 'agent',
      request: innerRequest,
    };

    const url = buildAntigravityUrl(Boolean(request.stream));

    const headers: Record<string, string | undefined> = {
      'x-goog-api-key': undefined,
      'X-Goog-Api-Key': undefined,
      'User-Agent': getAntigravityUserAgent(),
      // Claude thinking models ride the interleaved-thinking beta (the CCA
      // backend needs it to return thinking blocks for Anthropic ids).
      ...(family === 'claude' ? { 'anthropic-beta': CLAUDE_THINKING_BETA_HEADER } : {}),
    };

    return {
      body: envelope,
      config: { url, headers },
    };
  }

  /** antigravity request → unified (endpoint-decode parity with the gemini one). */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext,
  ): Promise<UnifiedChatRequest> {
    const r = request as Record<string, unknown>;
    const inner = (r && typeof r === 'object' && 'request' in r ? r.request : r) as Record<
      string,
      unknown
    >;
    if (inner && typeof inner === 'object' && !('model' in inner) && 'model' in r) {
      inner.model = r.model;
    }
    return toUnifiedRequest(inner);
  }

  /** antigravity response → OpenAI-compatible: peel `.response`, delegate. */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext,
  ): Promise<Response> {
    const unwrapped = await unwrapCcaResponse(response);
    return transformResponseOut(unwrapped, this.name, this.logger);
  }
}

/** Map ONE tool group's declarations onto the legacy `parameters` schema form. */
function legacyParametersTool(tool: {
  functionDeclarations?: Array<Record<string, unknown>>;
}): { functionDeclarations?: Array<Record<string, unknown>> } {
  if (!tool.functionDeclarations) return tool;
  return {
    functionDeclarations: tool.functionDeclarations.map((declaration) => {
      if ('parameters' in declaration) return declaration;
      const { parametersJsonSchema, ...rest } = declaration as {
        parametersJsonSchema?: Record<string, unknown>;
      } & Record<string, unknown>;
      return {
        ...rest,
        parameters: cleanSchemaForCcaLegacyParameters(parametersJsonSchema),
      };
    }),
  };
}
