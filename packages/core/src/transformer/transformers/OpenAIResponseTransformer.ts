/**
 * OpenAIResponseTransformer - Transformer for OpenAI Responses API
 *
 * Handles bidirectional conversion between unified (OpenAI Chat Completions)
 * format and OpenAI Responses API format (/v1/responses).
 *
 * @module transformer/transformers/OpenAIResponseTransformer
 */

import type {
  LLMProvider,
  Transformer,
  TransformerContext,
  TransformerLogger,
  UnifiedChatRequest,
  UnifiedChatRequestMeta,
  UnifiedMessage,
  UnifiedTool,
} from '../types';
import {
  extractReasoningIntent,
  normalizeThinkLevel,
  resolveReasoningPlan,
  resolveTargetModelCapabilities,
} from '../reasoning-effort';
import { chatUsageToResponsesUsage, responsesUsageToChatUsage } from './utils/usage-mapping';
import {
  DsmlStreamSuppressor,
  dsmlCallId,
  hasDsmlMarkup,
  isDsmlSalvageArmed,
  salvageDsmlToolCalls,
  warnDsmlUnarmed,
} from './utils/dsmlToolCalls';
import { recordDroppedField } from '../transformWarnings';
import { buildOpenAIResponseApiUrl } from '../../completion/url-builder';
import { OpenAIOperationError } from '../../openai-operation';
import { isCodexThreadDeliveryReceipt } from './utils/responsesBookkeeping';
import type { ReasoningReplayEntry } from './utils/reasoningReplay';
import { readAnthropicSSE } from './AnthropicSSE';

// ============================================================================
// Response API Types
// ============================================================================

interface ResponseApiInput {
  role: 'user' | 'assistant' | 'developer';
  content: string | Array<Record<string, unknown>>;
  tool_call_id?: string;
}

interface ResponseApiRequest {
  model: string;
  input: string | Array<ResponseApiInput | Record<string, unknown>>;
  /** The public Responses API's system prompt (codex sends a `developer` item instead). */
  instructions?: string;
  /** Newer Responses clients' spelling of `instructions`. */
  prompt?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  /** The Responses wire's `top_p` — representable on every reduced target. */
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  reasoning?: { effort: string; summary?: string };
  /** codex's stateless-session contract — admitted by the reduced gate, dropped here. */
  store?: boolean;
  include?: string[];
  truncation?: string;
  text?: { verbosity?: string; format?: Record<string, unknown> };
}

interface WireThinking {
  content?: string;
  signature?: string;
  blocks?: NonNullable<UnifiedMessage['thinking']>['blocks'];
  index?: number;
  type?: string;
  data?: string;
}
interface WireExtra extends Record<string, unknown> {
  responses?: { reasoning?: WireItem[] };
  omnicross?: { thinking?: WireThinking };
  google?: { parts?: unknown[]; [key: string]: unknown };
}
interface WirePart { type: string; text?: string; refusal?: string; annotations?: unknown[] }
interface WireItem extends Record<string, unknown> {
  type: string;
  id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  content?: WirePart[];
  summary?: WirePart[];
  extra_content?: WireExtra;
}
interface WireDelta {
  content?: string;
  refusal?: string;
  reasoning_content?: string;
  thinking?: WireThinking;
  extra_content?: WireExtra;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: WireExtra }>;
}
interface WireEvent {
  type?: string;
  model?: string;
  delta?: string;
  output_index: number;
  item?: WireItem;
  arguments?: string;
  input?: string;
  message?: string;
  code?: string;
  error?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  response?: { model?: string; usage?: Record<string, unknown>; error?: Record<string, unknown>; incomplete_details?: { reason?: string } };
  choices?: Array<{ index?: number; delta?: WireDelta; finish_reason?: string | null }>;
}

function mergeWireExtra(target: WireExtra | undefined, incoming: WireExtra): WireExtra {
  const merged = { ...target, ...incoming };
  if (target?.google && incoming.google) {
    merged.google = { ...target.google, ...incoming.google };
    if (target.google.parts && incoming.google.parts) {
      merged.google.parts = [...target.google.parts, ...incoming.google.parts];
    }
  }
  if (target?.responses?.reasoning && incoming.responses?.reasoning) {
    merged.responses = { reasoning: [...target.responses.reasoning, ...incoming.responses.reasoning] };
  }
  const previous = target?.omnicross?.thinking;
  const next = incoming.omnicross?.thinking;
  if (previous && next) {
    merged.omnicross = { thinking: {
      ...previous, ...next,
      content: (previous.content ?? '') + (next.content ?? ''),
      blocks: [...(previous.blocks ?? []), ...(next.blocks ?? [])],
    } };
  }
  return merged;
}

// ============================================================================
// Transformer Implementation
// ============================================================================

/**
 * OpenAIResponseTransformer handles OpenAI Responses API format conversion
 *
 * Features:
 * - Converts unified (OpenAI CC) requests to Response API format
 * - Converts Response API responses back to unified format
 * - Supports both streaming SSE and non-streaming JSON responses
 * - Bearer token authentication
 */
export class OpenAIResponseTransformer implements Transformer {
  static TransformerName = 'openai-response';
  name = 'openai-response';
  endPoint = '/v1/responses';
  logger?: TransformerLogger;

  /**
   * Handle authentication - Bearer token
   */
  async auth(
    request: unknown,
    provider: LLMProvider,
    _context: TransformerContext
  ): Promise<{ body: unknown; config: { headers: Record<string, string> } }> {
    return {
      body: request,
      config: {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
      },
    };
  }

  /**
   * Transform unified request → Response API format
   */
  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext
  ): Promise<Record<string, unknown>> {
    if (request.n !== undefined && request.n !== 1) {
      throw new OpenAIOperationError({
        status: 400, code: 'unsupported_capability',
        message: 'Responses supports only one candidate (n=1)',
      });
    }
    const codex = provider.responsesDialect === 'codex';
    const native = context.responsesDecodedMessages === request.messages
      ? context.responsesNativeRequest as Record<string, unknown> | undefined
      : undefined;
    if (native) {
      const body: Record<string, unknown> = { ...native, model: request.model };
      if (codex) {
        body.stream = true;
        body.store = false;
        delete body.max_output_tokens;
      }
      return { body, config: { url: new URL(buildOpenAIResponseApiUrl(provider.baseUrl)) } };
    }
    const source = request as unknown as Record<string, unknown>;
    if (Array.isArray(source._serverSideTools) && source._serverSideTools.length) {
      throw new Error('Responses cannot represent Anthropic server-side tools');
    }
    const input: Array<Record<string, unknown>> = [];
    const codexTools = request.meta?.codexTools as ResponsesCodexToolState | undefined;

    for (const msg of request.messages) {
      const nativeMessage = msg as unknown as Record<string, unknown>;
      const extra = nativeMessage.extra_content as WireExtra | undefined;
      if (msg.role === 'assistant' && extra?.responses?.reasoning) input.push(...extra.responses.reasoning);
      if (msg.role === 'system') {
        const sysText = typeof msg.content === 'string' ? msg.content : flattenContent(msg.content);
        input.push({
          role: 'developer',
          content: [{ type: 'input_text', text: sysText }],
        });
      } else if (msg.role === 'tool') {
        const callId = msg.tool_call_id;
        input.push({
          type: codexTools?.customToolCallIds?.includes(callId ?? '')
            ? 'custom_tool_call_output'
            : 'function_call_output',
          call_id: callId,
          output: msg.is_error
            ? [{ type: 'input_text', text: 'Tool execution failed.' }, ...unifiedContentToResponses(msg.content, false)]
            : typeof msg.content === 'string' ? msg.content : unifiedContentToResponses(msg.content, false),
        });
      } else {
        const content = unifiedContentToResponses(msg.content, msg.role === 'assistant');
        // An assistant turn that carried ONLY tool calls (Claude Code's usual
        // tool-only turn: thinking + `tool_use`, no prose) flattens to an empty
        // text. Emitting it as a message item puts an `output_text: ''` part in
        // front of the tool calls, and a strict third-party Responses upstream
        // rejects a request ENDING on that tool block with 400
        // `invalid_request_error` (Command Code, 2026-10-09 field report: an
        // input whose last items are `[assistant '', tool-call, tool-output]`
        // 400s, while the same input without the empty message passes).
        // There is nothing to carry, so the item is dropped; the tool calls
        // below still go out, which is the shape a native client sends.
        // Non-empty text (even a single space) is kept verbatim.
        if (msg.role === 'assistant' && content.length === 0 && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls ?? []) {
            input.push(encodeToolCallItem(
              tc.id,
              tc.function.name,
              tc.function.arguments,
              'completed',
              codexTools,
            ));
          }
          continue;
        }
        const entry: Record<string, unknown> = {
          role: msg.role,
          content,
        };
        // Include tool_calls as function_call items
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          // For Response API, tool calls are separate output items
          // Push the assistant text first, then each function_call
          input.push(entry);
          for (const tc of msg.tool_calls) {
            const callId = tc.id;
            input.push(encodeToolCallItem(
              callId,
              tc.function.name,
              tc.function.arguments,
              'completed',
              codexTools,
            ));
          }
          continue;
        }
        input.push(entry);
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: codex ? true : request.stream,
      store: false,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // R7 (claude-api-transform-fidelity): the Responses wire HAS `top_p`, so
      // the decoded hub value maps through — conditionally (absent ⇒ absent).
      ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
      ...(request.parallel_tool_calls !== undefined
        ? { parallel_tool_calls: request.parallel_tool_calls }
        : {}),
      ...(!codex && request.max_tokens !== undefined
        ? { max_output_tokens: request.max_tokens }
        : {}),
    };
    const format = request.response_format as Record<string, unknown> | undefined;
    if (format) {
      const schema = format.json_schema as Record<string, unknown> | undefined;
      body.text = { format: format.type === 'json_schema'
        ? { type: 'json_schema', ...schema }
        : { type: format.type } };
    }

    // R7 drops: the Responses API has NO `stop`/`top_k`/`user-id` parameters
    // (Q1 — the requirements text asserted a stop counterpart; the real API has
    // none, so these are audited rather than fabricated).
    if (request.stop !== undefined) recordDroppedField(request, 'stop', 'openai-responses');
    if (request.top_k !== undefined) recordDroppedField(request, 'top_k', 'openai-responses');
    if (request.metadata_user_id !== undefined) {
      recordDroppedField(request, 'metadata_user_id', 'openai-responses');
    }

    // Map reasoning config
    const reasoningPlan = resolveReasoningPlan({
      intent: extractReasoningIntent(request),
      model: request.model,
      provider,
      target: 'openai-responses',
      requestMaxTokens: request.max_tokens,
      preserveNativeEffort: context.reasoningSourceFormat === this.name,
    });
    if (reasoningPlan?.kind === 'level' && reasoningPlan.enabled) {
      body.reasoning = {
        effort: reasoningPlan.effort,
        summary: typeof context.responsesReasoningSummary === 'string'
          ? context.responsesReasoningSummary
          : 'auto',
      };
    } else if (reasoningPlan?.kind === 'off' && (request.reasoning?.enabled === false || request.reasoning?.effort === 'none')) {
      const capabilities = resolveTargetModelCapabilities(request.model, provider);
      const omitEffort = capabilities.thinkingLevels?.length === 1 && capabilities.thinkingLevels[0] === 'none';
      if (capabilities.reasoning !== false && !omitEffort) body.reasoning = { effort: 'none' };
    }

    // Map tools
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) =>
        codexTools?.customToolNames?.includes(tool.function.name)
          ? {
              type: 'custom',
              name: tool.function.name,
              description: tool.function.description,
            }
          : {
              type: 'function',
              name: tool.function.name,
              description: tool.function.description,
              parameters: tool.function.parameters,
              ...((tool.function as unknown as Record<string, unknown>).strict !== undefined
                ? { strict: (tool.function as unknown as Record<string, unknown>).strict }
                : {}),
            });
    }

    // Map tool_choice
    if (request.tool_choice) {
      if (typeof request.tool_choice === 'string') {
        body.tool_choice = request.tool_choice;
      } else if (typeof request.tool_choice === 'object' && 'function' in request.tool_choice) {
        body.tool_choice = {
          type: isCustomToolCallName(request.tool_choice.function.name, codexTools) ? 'custom' : 'function',
          name: request.tool_choice.function.name,
        };
      }
    }

    // PATH-PRESERVING URL: append the Responses path the SAME way
    // `buildOpenAIResponseApiUrl` does — a base path PREFIX (commandcode
    // `…/provider/v1/responses`, opencode-zen `…/zen/v1/responses`) must survive.
    // The previous `new URL('/v1/responses', baseUrl)` kept only the ORIGIN and
    // silently dropped every prefix, so a chat→responses BYO relay hit
    // `<origin>/v1/responses` → upstream 404 (commandcode field case 2026-09-29).
    // Full-endpoint bases (`…/responses`) and versioned bases (`…/v1`) keep
    // their prior resolution; only the prefix-dropping case changes.
    const url = new URL(buildOpenAIResponseApiUrl(provider.baseUrl));

    return { body, config: { url } };
  }

  /**
   * Transform Response API request → unified format
   */
  async transformRequestOut(
    request: unknown,
    context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    const req = request as ResponseApiRequest;
    context.responsesNativeRequest = request;
    delete context.responsesReasoningReplay;
    const messages: UnifiedMessage[] = [];
    context.responsesDecodedMessages = messages;
    // codex ships its tool declarations inside an `additional_tools` INPUT item
    // rather than the top-level `tools` field. The catalog is collected in a
    // PRE-PASS so every history tool call can be checked against it — codex's
    // world-state catalog is normally the first input item, but a resumed
    // transcript must not depend on that ordering. The main walk below merges
    // the same items again (idempotent: names dedup, sets union).
    let codexTools = collectCodexTools({ tools: req.tools });
    const inputItems = typeof req.input === 'string'
      ? [{ role: 'user', content: req.input }]
      : req.input ?? [];
    for (const item of inputItems) {
      const entry = item as Record<string, unknown>;
      if (entry && entry.type === 'additional_tools') {
        codexTools = mergeCodexTools(codexTools, collectCodexTools(entry));
      }
    }
    context.responsesSourceFormat = this.name;
    if (typeof req.reasoning?.summary === 'string') {
      context.responsesReasoningSummary = req.reasoning.summary;
    }

    // Reasoning replay capture. A `reasoning` input item is codex handing back
    // the thinking of a PRIOR assistant turn (its `summary` parts — under this
    // proxy that summary IS the upstream's full `reasoning_content`, see the
    // streaming encoder below). The item maps to no message of its own; its
    // text is attached to the assistant turn that FOLLOWS it and recorded on
    // the context (by unified-message index) for the chat encoder, which
    // replays it as `reasoning_content` only for upstreams that demand it —
    // DeepSeek v4 thinking mode 400s without it (utils/reasoningReplay).
    let pendingReasoningText = '';
    let pendingExtra: WireExtra | undefined;
    const attachPendingReasoning = () => {
      if (!pendingReasoningText && !pendingExtra) return;
      const message = messages[messages.length - 1];
      const nativeThinking = pendingExtra?.omnicross?.thinking;
      message.thinking = nativeThinking
        ? { ...nativeThinking, content: nativeThinking.content ?? pendingReasoningText }
        : { content: pendingReasoningText };
      if (pendingExtra) {
        const native = message as unknown as Record<string, unknown>;
        native.extra_content = mergeWireExtra(native.extra_content as WireExtra | undefined, pendingExtra);
      }
      if (pendingReasoningText) {
        ((context.responsesReasoningReplay as ReasoningReplayEntry[] | undefined) ??= []).push({
          messageIndex: messages.length - 1,
          text: pendingReasoningText,
        });
      }
      pendingExtra = undefined;
      pendingReasoningText = '';
    };

    // The public Responses API carries the system prompt in `instructions`
    // (codex instead sends it as a `developer` message item); newer clients
    // spell it `prompt`. Dropping it lost the caller's entire system prompt
    // silently.
    const instructions = typeof req.instructions === 'string'
      ? req.instructions
      : typeof req.prompt === 'string' ? req.prompt : '';
    if (instructions) {
      messages.push({ role: 'system', content: instructions });
    }

    if (req.input !== undefined) {
      for (const item of inputItems) {
        const entry = item as Record<string, unknown>;
        const itemType = typeof entry.type === 'string' ? entry.type : undefined;
        if ((pendingReasoningText || pendingExtra) && (entry.role === 'user' || entry.role === 'system' || entry.role === 'developer' || itemType === 'function_call_output' || itemType === 'custom_tool_call_output')) {
          messages.push({ role: 'assistant', content: null });
          attachPendingReasoning();
        }

        if ((itemType && SKIPPED_INPUT_ITEM_TYPES.has(itemType)) || isCodexThreadDeliveryReceipt(entry)) continue;

        // A replayed reasoning item: no message of its own — stash the summary
        // text for the assistant turn that follows (see attachPendingReasoning).
        // `encrypted_content` (OpenAI-only opaque replay) is unusable here and
        // deliberately ignored.
        if (itemType === 'reasoning') {
          if (isResponsesRecord(entry.extra_content)) pendingExtra = mergeWireExtra(pendingExtra, entry.extra_content as WireExtra);
          if (typeof entry.encrypted_content === 'string') {
            pendingExtra = mergeWireExtra(pendingExtra, { responses: { reasoning: [entry as WireItem] } });
          }
          const summary = Array.isArray(entry.summary) ? entry.summary : [];
          let text = '';
          for (const part of summary) {
            const partText = (part as Record<string, unknown> | undefined)?.text;
            if (typeof partText === 'string' && partText) {
              text = text ? `${text}\n${partText}` : partText;
            }
          }
          if (text) {
            pendingReasoningText = pendingReasoningText
              ? `${pendingReasoningText}\n${text}`
              : text;
          }
          continue;
        }

        // codex's tool declarations. Merged into `result.tools` below; the item
        // itself carries `role:'developer'` with no content and must not become
        // a message.
        if (itemType === 'additional_tools') {
          codexTools = mergeCodexTools(codexTools, collectCodexTools(entry));
          continue;
        }

        // A custom tool RESULT. Same array-vs-string `output` shape as
        // `function_call_output`, so it gets the same flattening.
        if (itemType === 'custom_tool_call_output') {
          rememberCustomCall(codexTools, entry.call_id);
          messages.push({
            role: 'tool',
            content: responsesContentToUnified(entry.output) ?? '',
            tool_call_id: (entry.call_id as string) || undefined,
          });
          continue;
        }

        // A custom tool CALL. codex carries the payload as free-form text in
        // `input`; the chat wire wants JSON arguments, so it is wrapped in the
        // `{input:…}` envelope declared by CUSTOM_TOOL_PARAMETERS. The response
        // encoder unwraps it again.
        if (itemType === 'custom_tool_call') {
          // Namespaced custom calls ride the FLATTENED wire name, exactly like
          // `function_call` history below — the model only knows the flattened
          // declaration (see collectCodexTools), and a history call under a
          // different name is rejected by strict upstreams. An item WITHOUT a
          // namespace is matched against the catalog instead (a resumed
          // transcript may hold calls recorded before the namespace was
          // restored).
          const rawName = (entry.name as string) || '';
          const wireName = resolveDeclaredWireName(rawName, codexTools);
          const ns = typeof entry.namespace === 'string'
            ? entry.namespace
            : (codexTools.toolNamespaces[wireName] ?? '');
          const flatName = ns && !wireName.startsWith(`${ns}__`) ? `${ns}__${wireName}` : wireName;
          rememberToolNamespace(codexTools, flatName, entry.namespace);
          rememberCustomCall(codexTools, entry.call_id ?? entry.id, flatName);
          const toolCall = {
            ...(entry.extra_content ? { extra_content: entry.extra_content } : {}),
            id: ((entry.call_id ?? entry.id) as string) || '',
            type: 'function' as const,
            function: {
              name: flatName,
              arguments: JSON.stringify({
                input: typeof entry.input === 'string' ? entry.input : '',
              }),
            },
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant' && !pendingReasoningText && !pendingExtra) {
            (last.tool_calls ??= []).push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
            attachPendingReasoning();
          }
          if (isResponsesRecord(entry.extra_content)) {
            const native = messages[messages.length - 1] as unknown as Record<string, unknown>;
            native.extra_content = mergeWireExtra(native.extra_content as WireExtra | undefined, entry.extra_content as WireExtra);
          }
          continue;
        }

        // Handle function_call_output (tool results). `output` is a plain string
        // for most tools, but codex sends an ARRAY of `input_text` parts when a
        // result has several segments (exit code / wall time / stdout). Relaying
        // that array verbatim put Responses part types inside an OpenAI-chat
        // `content`, which upstreams reject (z.ai: `messages[N].content[0].type
        // type error`) — and the resulting upstream error surfaced to the client
        // as a truncated stream, not as the 400 it was. Flatten to text.
        if (itemType === 'function_call_output') {
          messages.push({
            role: 'tool',
            content: responsesContentToUnified(entry.output) ?? '',
            tool_call_id: (entry.call_id as string) || undefined,
          });
          continue;
        }

        // Handle function_call (assistant tool CALL items — they carry no `role`).
        // This is the inverse of `transformRequestIn`'s encode: an assistant turn
        // with tool_calls is emitted as a `{role:'assistant'}` text item followed
        // by one `{type:'function_call'}` item per tool call. Attach the call to the
        // most-recent assistant message if it is the last pushed message (mirrors the
        // encode grouping); otherwise start a fresh assistant message.
        if (itemType === 'function_call') {
          rememberToolNamespace(codexTools, entry.name, entry.namespace);
          // Namespaced calls ride the SAME flattened wire name as their
          // declaration (see collectCodexTools) — the model only knows
          // the flattened name, and history calls for undeclared names
          // are rejected by strict upstreams. A bare history name (one the
          // upstream dropped the namespace from) is matched against the
          // catalog so replays don't send an undeclared tool name.
          const rawName = (entry.name as string) || '';
          const wireName = resolveDeclaredWireName(rawName, codexTools);
          const ns = typeof entry.namespace === 'string' && entry.namespace
            ? entry.namespace
            : (codexTools.toolNamespaces[wireName] ?? '');
          const toolCall = {
            ...(entry.extra_content ? { extra_content: entry.extra_content } : {}),
            id: ((entry.call_id ?? entry.id) as string) || '',
            type: 'function' as const,
            function: {
              name: ns && !wireName.startsWith(`${ns}__`) ? `${ns}__${wireName}` : wireName,
              arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
            },
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant' && !pendingReasoningText && !pendingExtra) {
            (last.tool_calls ??= []).push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
            attachPendingReasoning();
          }
          if (isResponsesRecord(entry.extra_content)) {
            const native = messages[messages.length - 1] as unknown as Record<string, unknown>;
            native.extra_content = mergeWireExtra(native.extra_content as WireExtra | undefined, entry.extra_content as WireExtra);
          }
          continue;
        }

        // Everything reaching here is a message item — either `{type:'message',
        // role, content}` or the bare `{role, content}` shorthand; every other
        // item type was skipped above. `content` is a string or an array of
        // typed parts; it was previously `JSON.stringify`d, so the upstream
        // model literally read `[{"type":"input_text","text":"…"}]` instead of
        // the text. Flatten it.
        const role = entry.role as string;
        // Defensive: an item with a role but no usable content would otherwise
        // emit a `{"role":"system"}` message with `content: undefined`, which
        // some upstreams reject outright. System/developer stays text-only
        // (no vision shape for system prompts); user content may promote to
        // text+image blocks (responsesContentToUnified).
        if (role === 'developer' || role === 'system') {
          const text = flattenContent(entry.content);
          if (!text) continue;
          messages.push({ role: 'system', content: text });
        } else if (role === 'user' || role === 'assistant') {
          const content = responsesContentToUnified(entry.content);
          if (content === undefined) continue;
          messages.push({ role, content, ...(entry.extra_content ? { extra_content: entry.extra_content } : {}) });
          if (role === 'assistant') attachPendingReasoning();
        }
      }
    }
    if (pendingReasoningText || pendingExtra) {
      messages.push({ role: 'assistant', content: null });
      attachPendingReasoning();
    }

    const result: UnifiedChatRequest = {
      messages,
      model: req.model,
      max_tokens: req.max_output_tokens,
      temperature: req.temperature,
      stream: req.stream,
    };

    const effort = normalizeThinkLevel(req.reasoning?.effort);
    if (effort) {
      context.reasoningSourceFormat = this.name;
      result.reasoning = {
        effort,
        enabled: effort !== 'none',
      };
    }

    // Tools come from BOTH the standard top-level `tools` field and codex's
    // `additional_tools` input item; a client may use either.
    const tools: UnifiedTool[] = [];
    if (codexTools.tools.length) {
      const declared = new Set(tools.map((t) => t.function.name));
      tools.push(...codexTools.tools.filter((t) => !declared.has(t.function.name)));
    }
    if (tools.length) result.tools = tools;

    // tool_choice — the Responses forms onto the unified (chat) form. String
    // modes pass through; the Responses function form `{type:'function',
    // name}` becomes the chat `{type:'function', function:{name}}`
    // (namespace-qualified names flatten to their last segment — the same bare
    // name namespace declarations flatten to). codex's `allowed_tools` choice
    // restricts WHICH declared tools may run and HOW they may be chosen; no
    // target wire has that construct, so it is emulated: the mode maps to the
    // closest choice mode and the declared tool list is filtered to the
    // allowlist (every target selects among the declared tools only, so the
    // filter IS the restriction).
    applyResponsesToolChoice(result, req.tool_choice, codexTools);

    if (typeof req.parallel_tool_calls === 'boolean') {
      result.parallel_tool_calls = req.parallel_tool_calls;
    }

    // The Responses wire's `top_p` maps through to every reduced target (the
    // decode-side mirror of transformRequestIn's R7 comment).
    if (typeof req.top_p === 'number') {
      result.top_p = req.top_p;
    }

    // Session/decoration hints admitted by the reduced-profile gate with no
    // unified representation: the stateless codex contract (`store:false`),
    // encrypted-reasoning replay (`include`), server-side compaction
    // (`truncation`), output verbosity (`text.verbosity`). Audited, never
    // forwarded. `prompt_cache_key` is consumed by the ingress (session
    // derivation / cache attribution) before this point and needs no audit.
    if (req.store !== undefined) recordDroppedField(result, 'store', 'openai-responses');
    if (req.include !== undefined) recordDroppedField(result, 'include', 'openai-responses');
    if (req.truncation !== undefined) recordDroppedField(result, 'truncation', 'openai-responses');
    if (req.text?.verbosity !== undefined) {
      recordDroppedField(result, 'text.verbosity', 'openai-responses');
    }

    // `text.format` is the structured-output CONTRACT, not a hint: json_schema
    // maps onto the chat wire's `response_format` (Gemini re-maps it to
    // responseMimeType/responseSchema downstream; Anthropic-shaped targets
    // never reach here — the gate refuses the field for them).
    const textFormat = req.text?.format;
    if (isResponsesRecord(textFormat) && typeof textFormat.type === 'string') {
      if (textFormat.type === 'json_schema' && isResponsesRecord(textFormat.schema)) {
        result.response_format = {
          type: 'json_schema',
          json_schema: {
            ...(typeof textFormat.name === 'string' ? { name: textFormat.name } : {}),
            ...(typeof textFormat.strict === 'boolean' ? { strict: textFormat.strict } : {}),
            schema: textFormat.schema,
          },
        };
      } else if (textFormat.type === 'text' || textFormat.type === 'json_object') {
        result.response_format = { type: textFormat.type };
      }
    }

    // Thread the custom-tool / namespace state to the response encoder. `meta`
    // is internal-only and never serialised into the outbound body.
    if (
      codexTools.customToolNames.length ||
      codexTools.customToolCallIds.length ||
      Object.keys(codexTools.toolNamespaces).length
    ) {
      result.meta = {
        ...result.meta,
        codexTools: {
          ...(codexTools.customToolNames.length
            ? { customToolNames: codexTools.customToolNames }
            : {}),
          ...(codexTools.customToolCallIds.length
            ? { customToolCallIds: codexTools.customToolCallIds }
            : {}),
          ...(Object.keys(codexTools.toolNamespaces).length
            ? { toolNamespaces: codexTools.toolNamespaces }
            : {}),
        } as ResponsesCodexToolState,
      };
    }

    return result;
  }

  /**
   * Transform Response API response → unified (OpenAI CC) format
   */
  async transformResponseOut(
    response: Response,
    _context: TransformerContext
  ): Promise<Response> {
    if (!response.ok) return response;
    const contentType = response.headers.get('Content-Type') ?? '';

    // ChatGPT's codex backend OMITS Content-Type on SSE streams, so a header
    // check alone misroutes them into the JSON branch (which throws
    // "Unexpected token 'e'" on the leading `event:` line). Peek the first
    // chunk to detect an SSE frame when the header is absent.
    let isSse = contentType.includes('text/event-stream');
    if (!isSse && !contentType.includes('application/json') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const prefix: Uint8Array[] = [];
      let head = '';
      let ended = false;
      try {
        while (true) {
          const next = await reader.read();
          ended = next.done;
          if (next.value) {
            prefix.push(next.value);
            head += decoder.decode(next.value, { stream: true });
          }
          const trimmed = head.trimStart();
          isSse = trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.startsWith(':');
          if (ended || isSse || (trimmed && !'event:'.startsWith(trimmed) && !'data:'.startsWith(trimmed))) break;
        }
      } catch (error) {
        try { await reader.cancel(error); } finally { reader.releaseLock(); }
        throw error;
      }
      let cancelled = false;
      response = new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of prefix) controller.enqueue(chunk);
          if (ended) { controller.close(); reader.releaseLock(); }
        },
        async pull(controller) {
          if (ended || cancelled) return;
          try {
            const next = await reader.read();
            if (cancelled) return;
            if (next.done) {
              ended = true;
              controller.close();
              reader.releaseLock();
            } else controller.enqueue(next.value);
          } catch (error) {
            if (!cancelled) controller.error(error);
            ended = true;
            try { await reader.cancel(error); } finally { reader.releaseLock(); }
          }
        },
        async cancel(reason) {
          cancelled = true;
          if (!ended) {
            try { await reader.cancel(reason); } finally { reader.releaseLock(); }
          }
        },
      }), { status: response.status, headers: response.headers });
    }

    if (isSse) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      return new Response(convertResponseApiStreamToOpenAI(response.body), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(convertResponseApiJsonToOpenAI(data)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Transform OpenAI CC response → Response API format
   */
  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    if (!response.ok) return response;
    const contentType = response.headers.get('Content-Type') ?? '';
    // Request-scoped codex protocol state, recorded by `transformRequestOut`
    // and threaded here on `context.req` by `executeResponseChain`. Absent for
    // non-codex clients, which simply get plain `function_call` items.
    const codexTools = (context?.req as UnifiedChatRequest | undefined)?.meta?.codexTools;

    // DeepSeek serializes tool calls as DSML markup and occasionally fails to
    // parse its own block back into `tool_calls`; the raw markup then reaches
    // codex as ordinary prose and the turn ends without running a single tool.
    // Salvage it for DeepSeek only — every other upstream writes real structured
    // tool calls, and reinterpreting markup there would dispatch something the
    // model merely talked about. `OMNICROSS_DEEPSEEK_DSML_SALVAGE` switches it
    // off (or onto every upstream); see utils/dsmlToolCalls.
    const requestModel = (context?.req as UnifiedChatRequest | undefined)?.model;
    const dsmlArmed = isDsmlSalvageArmed(requestModel, context?.providerName);

    if (contentType.includes('text/event-stream')) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      return new Response(
        convertOpenAIStreamToResponseApi(response.body, codexTools, dsmlArmed),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        }
      );
    }

    const data = await response.json();
    return new Response(JSON.stringify(convertOpenAIJsonToResponseApi(data, codexTools, dsmlArmed)), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Content-part types that carry plain text. `input_text` is the user/developer
 * part type, `output_text` the assistant one, `summary_text` a reasoning
 * summary, and `text` the unified (OpenAI-chat) spelling — this helper runs in
 * BOTH directions, so it accepts both vocabularies. Anything else (images,
 * files) contributes no text.
 */
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text', 'summary_text']);

/**
 * Responses `input` item types with no OpenAI-chat equivalent — dropped on decode.
 *
 * - `agent_message` — codex multi-agent inbound message; no chat role fits it.
 *
 * `reasoning` is NOT skipped: its `summary_text` parts are stashed on the
 * transformer context (see `responsesReasoningReplay`) so a chat upstream that
 * demands `reasoning_content` passback — DeepSeek v4 thinking mode — can be
 * served; see `utils/reasoningReplay`. The item itself still becomes no message.
 *
 * `additional_tools`, `custom_tool_call` and `custom_tool_call_output` are NOT
 * dropped: see `collectCodexTools` and the custom-tool branches in
 * `transformRequestOut`.
 */
const SKIPPED_INPUT_ITEM_TYPES = new Set(['agent_message']);

/**
 * Parameter schema a codex `custom` tool is exposed with.
 *
 * A custom tool takes FREE-FORM text (codex constrains it with a lark grammar,
 * e.g. `exec` receives raw JavaScript), whereas OpenAI-chat function tools take
 * JSON arguments. Declaring one required `input` string is the faithful
 * flattening: the model writes its free-form payload into `input`, and the
 * response encoder unwraps it straight back into the `custom_tool_call.input`
 * field codex expects.
 */
const CUSTOM_TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    input: {
      type: 'string',
      description: 'The complete free-form input for this tool, passed through verbatim.',
    },
  },
  required: ['input'],
} as const;

/** Request-scoped codex protocol state threaded from decode to encode. */
type CodexToolState = UnifiedChatRequestMeta['codexTools'];
type ResponsesCodexToolState = NonNullable<CodexToolState> & {
  customToolCallIds?: string[];
};

/**
 * Unwrap a custom tool's free-form payload from the `{input:…}` JSON envelope
 * the model was asked to produce (see `CUSTOM_TOOL_PARAMETERS`).
 *
 * Falls back to the raw argument string when the model ignored the schema or
 * the stream was cut mid-JSON: passing the payload through imperfectly beats
 * dropping the tool call entirely.
 */
function unwrapCustomToolInput(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.input === 'string') {
        return parsed.input;
      }
      // A model that ignored the declared `input` property may still package
      // the free-form payload as ONE string under another key (DeepSeek emits
      // `{"code":"…"}` for `exec` under some prompts). A single string value
      // is unambiguous about which text the tool meant; anything else stays
      // JSON so nothing is silently reinterpreted.
      const values = Object.values(parsed);
      if (values.length === 1 && typeof values[0] === 'string') {
        return values[0];
      }
    }
  } catch {
    /* not valid JSON — fall through to the raw text */
  }
  return argumentsJson;
}

/**
 * Resolve a tool-call name from the upstream back to the FLATTENED declared
 * wire name codex's catalog registered.
 *
 * The declaration side flattens `<namespace>__<name>` (see collectCodexTools),
 * but not every model honours it: DeepSeek picks the bare member name (`exec`)
 * whenever the surrounding instructions call the tool that way, even though the
 * declared name is `functions__exec`. That mismatch is fatal — the call comes
 * back as an unregistered `function_call`, and codex's registry aborts the turn
 * ("invoked with incompatible payload") before the tool ever runs.
 *
 * Exact matches win. Otherwise a bare name binds to the UNIQUE declared wire
 * name ending in `__<name>`; with two candidates in different namespaces there
 * is no safe guess, so the name is left untouched.
 */
export function resolveDeclaredWireName(name: string, codexTools: CodexToolState): string {
  if (!name || !codexTools) return name;
  const declared = new Set<string>(codexTools.customToolNames ?? []);
  for (const wireName of Object.keys(codexTools.toolNamespaces ?? {})) {
    declared.add(wireName);
  }
  if (declared.has(name)) return name;
  const qualified = name.replaceAll('.', '__');
  if (declared.has(qualified)) return qualified;

  const suffix = `__${name}`;
  let match: string | undefined;
  for (const wireName of declared) {
    if (!wireName.endsWith(suffix)) continue;
    if (match !== undefined) return name; // ambiguous across namespaces
    match = wireName;
  }
  return match ?? name;
}

/** Whether this upstream tool-call name belongs to a codex `custom` tool. */
export function isCustomToolCallName(name: string, codexTools: CodexToolState): boolean {
  if (!codexTools?.customToolNames?.length) return false;
  return codexTools.customToolNames.includes(resolveDeclaredWireName(name, codexTools));
}

/**
 * Encode ONE OpenAI-chat tool call as the Responses output item codex expects.
 *
 * A tool codex declared `type:'custom'` MUST come back as a `custom_tool_call`
 * carrying free-form `input`; sending it a `function_call` for a tool it
 * registered as custom leaves the call unroutable. Everything else is a
 * `function_call`, with the codex `namespace` restored when the tool came from
 * one. Item ids must carry the protocol's prefix (`ctc_` / `fc_`), which is
 * synthesized from the call id since the chat wire has only that one handle.
 */
export function encodeToolCallItem(
  callId: string,
  name: string,
  argumentsJson: string,
  status: 'in_progress' | 'completed',
  codexTools: CodexToolState,
): Record<string, unknown> {
  const bareId = callId;
  // A provider may answer with the bare member name; look it up as the
  // flattened name its declaration actually registered (see
  // resolveDeclaredWireName — DeepSeek's `exec` for `functions__exec`).
  const wireName = resolveDeclaredWireName(name, codexTools);

  const namespace = codexTools?.toolNamespaces?.[wireName];
  // The wire name is the FLATTENED `<namespace>__<name>`; codex expects the
  // bare name plus the separate namespace axis on the item. This holds for the
  // custom branch too — emitting the flattened name verbatim leaves codex with
  // an unregistered `functions__exec` and the call dies as
  // "unsupported custom tool call" (the `functions` namespace is how responses
  // lite ships EVERY built-in tool, exec included).
  const bareName = namespace && wireName.startsWith(`${namespace}__`)
    ? wireName.slice(namespace.length + 2)
    : wireName;

  if (codexTools?.customToolNames?.includes(wireName)) {
    return {
      id: `ctc_${bareId}`,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name: bareName,
      ...(namespace ? { namespace } : {}),
      input: unwrapCustomToolInput(argumentsJson),
    };
  }

  return {
    id: `fc_${bareId}`,
    type: 'function_call',
    status,
    call_id: callId,
    name: bareName,
    ...(namespace ? { namespace } : {}),
    arguments: argumentsJson,
  };
}

/** What `collectCodexTools` recovers from an `additional_tools` item. */
export interface CodexToolDeclarations {
  tools: UnifiedTool[];
  /** Names declared `type:'custom'` — re-encoded as `custom_tool_call` on the way back. */
  customToolNames: string[];
  /** Call handles whose request/output item must stay custom on re-encode. */
  customToolCallIds: string[];
  /** Tool name → codex namespace, restored onto `function_call` items on the way back. */
  toolNamespaces: Record<string, string>;
}

/**
 * Decode codex's `additional_tools` item into plain OpenAI-chat function tools.
 *
 * codex does NOT use the top-level `tools` field — it ships every tool inside one
 * `{type:'additional_tools', role:'developer', tools:[…]}` input item, in three
 * flavours:
 *   - `{type:'function', name, description, parameters}` — already chat-shaped.
 *   - `{type:'namespace', name, tools:[…]}` — a group (e.g. `collaboration`)
 *     whose members are functions. The MEMBER name is what the model calls; the
 *     namespace is carried on codex's `function_call` item as a separate field,
 *     so it is recorded and restored rather than baked into the name.
 *   - `{type:'custom', name, description, format}` — free-form text tool,
 *     flattened onto `CUSTOM_TOOL_PARAMETERS` (see there).
 *
 * Dropping this item left the upstream request with NO tools at all, so the
 * model could only ever answer in prose — codex's whole agent loop was dead.
 */
export function collectCodexTools(entry: Record<string, unknown>): CodexToolDeclarations {
  const result: CodexToolDeclarations = {
    tools: [],
    customToolNames: [],
    customToolCallIds: [],
    toolNamespaces: {},
  };

  const visit = (declarations: unknown, namespace?: string): void => {
    if (!Array.isArray(declarations)) return;
    for (const raw of declarations) {
      if (!raw || typeof raw !== 'object') continue;
      const tool = raw as Record<string, unknown>;
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (!name) continue;
      const description = typeof tool.description === 'string' ? tool.description : '';

      if (tool.type === 'namespace') {
        visit(tool.tools, name);
        continue;
      }

      // NAMESPACED FLATTENING: a flat wire (chat/anthropic) has no namespace
      // axis, so a namespaced tool rides as `<namespace>__<name>` (codex's own
      // flat naming convention, cf. its `mcp__server` namespace ids). The bare
      // name MUST NOT be used: two namespaces declaring the same inner name
      // (e.g. `search` under two MCP servers) then collide and the upstream
      // rejects the whole request ("Tool names must be unique" — observed on
      // the official DeepSeek chat wire). The reconstruction map keys the
      // FLATTENED name; the decode strips the prefix back into
      // `{name, namespace}` for codex.
      const wireName = namespace ? `${namespace}__${name}` : name;
      if (result.tools.some((existing) => existing.function.name === wireName)) continue;

      if (tool.type === 'custom') {
        result.customToolNames.push(wireName);
        result.tools.push({
          type: 'function',
          function: {
            name: wireName,
            description,
            parameters: CUSTOM_TOOL_PARAMETERS as unknown as UnifiedTool['function']['parameters'],
          },
        });
      } else if (tool.type === 'function') {
        result.tools.push({
          type: 'function',
          function: {
            name: wireName,
            description,
            parameters: (tool.parameters || {}) as UnifiedTool['function']['parameters'],
            ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
          },
        });
      } else {
        continue;
      }

      if (namespace) result.toolNamespaces[wireName] = namespace;
    }
  };

  visit(entry.tools);
  return result;
}

export function mergeCodexTools(
  left: CodexToolDeclarations,
  right: CodexToolDeclarations,
): CodexToolDeclarations {
  const tools = [...left.tools];
  const names = new Set(tools.map((tool) => tool.function.name));
  for (const tool of right.tools) {
    if (!names.has(tool.function.name)) tools.push(tool);
  }
  return {
    tools,
    customToolNames: [...new Set([...left.customToolNames, ...right.customToolNames])],
    customToolCallIds: [...new Set([...left.customToolCallIds, ...right.customToolCallIds])],
    toolNamespaces: { ...left.toolNamespaces, ...right.toolNamespaces },
  };
}

function rememberCustomCall(
  state: CodexToolDeclarations,
  rawCallId: unknown,
  rawName?: unknown,
): void {
  if (typeof rawCallId === 'string' && rawCallId && !state.customToolCallIds.includes(rawCallId)) {
    state.customToolCallIds.push(rawCallId);
  }
  if (typeof rawName === 'string' && rawName && !state.customToolNames.includes(rawName)) {
    state.customToolNames.push(rawName);
  }
}

function rememberToolNamespace(
  state: CodexToolDeclarations,
  rawName: unknown,
  rawNamespace: unknown,
): void {
  if (
    typeof rawName === 'string' && rawName &&
    typeof rawNamespace === 'string' && rawNamespace
  ) {
    state.toolNamespaces[rawName] = rawNamespace;
  }
}

function isResponsesRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Responses content → unified message content. Text-only input collapses to a
 * plain string (byte-identical to the historical flatten); input_image parts
 * promote the value to the unified block array so the vision-capable wires
 * (Anthropic image blocks — including tool_result — chat image_url parts,
 * Gemini inlineData) can carry them.
 */
function unifiedContentToResponses(content: UnifiedMessage['content'], assistant: boolean): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content || !assistant ? [{ type: assistant ? 'output_text' : 'input_text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (part.type === 'text') return { type: assistant ? 'output_text' : 'input_text', text: part.text };
    if (part.type === 'image_url' && !assistant) return {
      type: 'input_image',
      image_url: part.image_url.url,
      ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
    };
    throw new Error(`Responses cannot represent ${part.type} in this message`);
  });
}

function responsesContentToUnified(
  content: unknown,
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.length === 0) return '';
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
      continue;
    }
    if (!isResponsesRecord(part)) continue;
    if (part.type === 'input_image' && typeof part.image_url === 'string' && part.image_url) {
      blocks.push({ type: 'image_url', image_url: {
        url: part.image_url,
        ...(part.detail === 'auto' || part.detail === 'low' || part.detail === 'high' ? { detail: part.detail } : {}),
      } });
      continue;
    }
    if (part.type === 'refusal' && typeof part.refusal === 'string') {
      blocks.push({ type: 'text', text: part.refusal });
      continue;
    }
    if (typeof part.type === 'string' && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
    }
  }
  if (blocks.length === 0) return undefined;
  const hasImage = blocks.some((block) => block.type === 'image_url');
  if (!hasImage) return blocks.map((block) => (block as { text: string }).text).join('\n');
  return blocks;
}

/** `collaboration.spawn_agent` → `spawn_agent` — the flattened declaration name. */
function bareToolName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/** Namespace-qualified allowlist entries match the flattened declaration name. */
function toolNameAllowed(allowed: Set<string>, name: string): boolean {
  if (allowed.has(name)) return true;
  for (const entry of allowed) {
    if (entry.endsWith(`.${name}`) || name.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function applyResponsesToolChoice(
  result: UnifiedChatRequest,
  choice: unknown,
  codexTools: CodexToolState,
): void {
  if (choice === undefined || choice === null) return;
  if (typeof choice === 'string') {
    result.tool_choice = choice;
    return;
  }
  if (!isResponsesRecord(choice)) return;
  if ((choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string') {
    result.tool_choice = {
      type: 'function',
      function: { name: resolveDeclaredWireName(choice.name, codexTools) === choice.name
        ? bareToolName(choice.name)
        : resolveDeclaredWireName(choice.name, codexTools) },
    };
    return;
  }
  if (choice.type === 'allowed_tools') {
    result.tool_choice = choice.mode === 'required' ? 'required' : 'auto';
    const entries = Array.isArray(choice.tools) ? choice.tools : [];
    const allowed = new Set(
      entries
        .map((tool) => isResponsesRecord(tool) && typeof tool.name === 'string' ? resolveDeclaredWireName(tool.name, codexTools) : undefined)
        .filter((name): name is string => name !== undefined),
    );
    if (result.tools?.length) {
      result.tools = result.tools.filter((tool) => toolNameAllowed(allowed, tool.function.name));
    }
  }
}

/**
 * Flatten any Responses-API content value to plain text.
 *
 * Handles the shapes that actually appear on the wire:
 *   - a bare string
 *   - an array of typed parts (`[{type:'input_text', text:'…'}, …]`)
 *   - a `{content:[…]}` / `{text:'…'}` wrapper
 *
 * Codex splits one tool result into SEVERAL parts (exit code, wall time,
 * stdout), so parts are joined with a newline. An unrecognized shape yields ''
 * — callers drop empty messages rather than forward `undefined` upstream.
 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const c = part as Record<string, unknown>;
        if (typeof c.type === 'string' && !TEXT_PART_TYPES.has(c.type)) return '';
        return typeof c.text === 'string' ? c.text : '';
      })
      .filter((text) => text !== '')
      .join('\n');
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.content)) return flattenContent(obj.content);
  }
  return '';
}

// ============================================================================
// Non-streaming JSON Conversion
// ============================================================================

function convertResponseApiJsonToOpenAI(data: Record<string, unknown>): Record<string, unknown> {
  if (data.error || data.status === 'failed') {
    return { error: data.error ?? { message: 'Response failed' } };
  }
  let textContent = '';
  let reasoningContent = '';
  let refusal = '';
  const toolCalls: Array<Record<string, unknown>> = [];
  let extra: WireExtra | undefined;
  for (const item of (data.output ?? []) as WireItem[]) {
    if (item.extra_content) extra = mergeWireExtra(extra, item.extra_content);
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') textContent += part.text ?? '';
        if (part.type === 'refusal') refusal += part.refusal ?? '';
      }
    } else if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string') extra = mergeWireExtra(extra, { responses: { reasoning: [item] } });
      reasoningContent += (item.summary ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        ...(item.extra_content ? { extra_content: item.extra_content } : {}),
        type: 'function',
        function: {
          name: item.name,
          arguments: item.type === 'custom_tool_call'
            ? JSON.stringify({ input: item.input ?? '' })
            : typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = { role: 'assistant', content: textContent || null };
  if (extra) message.extra_content = extra;
  if (extra?.omnicross?.thinking) message.thinking = extra.omnicross.thinking;
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (refusal) message.refusal = refusal;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const incomplete = data.incomplete_details as { reason?: string } | undefined;
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: data.created_at ?? Math.floor(Date.now() / 1000),
    model: data.model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: data.status === 'incomplete'
        ? incomplete?.reason === 'content_filter' ? 'content_filter' : 'length'
        : toolCalls.length ? 'tool_calls' : 'stop',
    }],
    usage: responsesUsageToChatUsage(data.usage as Record<string, unknown> | undefined),
  };
}

function convertOpenAIJsonToResponseApi(
  data: Record<string, unknown>,
  codexTools?: CodexToolState,
  dsmlArmed = false
): Record<string, unknown> {
  if (data.error) return { object: 'response', status: 'failed', error: data.error, output: [] };
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 1) {
    throw new Error('Multiple Chat candidates cannot be represented by one Responses result');
  }
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  if (message) {
    // The upstream's own model name is the most reliable DeepSeek signal — the
    // request carried a client-facing name that upstream mapping may have
    // rewritten, while `data.model` is what actually answered. The switch gates
    // THIS arm too, or turning the salvage off would not turn it off.
    const salvage = dsmlArmed || isDsmlSalvageArmed(undefined, undefined, data.model);
    let content = message.content;
    const toolCalls = Array.isArray(message.tool_calls)
      ? [...(message.tool_calls as Array<Record<string, unknown>>)]
      : [];

    if (typeof content === 'string' && hasDsmlMarkup(content)) {
      if (!salvage) {
        // Diagnosable rather than silent: the model IS leaking markup, the
        // salvage merely was not armed for this upstream's name.
        warnDsmlUnarmed(data.model);
      } else {
        const salvaged = salvageDsmlToolCalls(content);
        if (salvaged.calls.length || toolCalls.length) content = salvaged.cleaned;
        // Only synthesize when the upstream decoded NOTHING. A response can carry
        // BOTH structured tool_calls and leaked markup; re-adding those calls
        // would dispatch every tool a second time.
        if (toolCalls.length === 0) {
          salvaged.calls.forEach((call, index) => {
            toolCalls.push({
              id: dsmlCallId(call, index),
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            });
          });
        }
      }
    }

    const contentParts: Array<Record<string, unknown>> = [];
    if (typeof content === 'string' && content.length > 0) {
      contentParts.push({ type: 'output_text', text: content, annotations: [] });
    }
    // A thinking upstream answers with `reasoning_content`; surface it as a
    // `reasoning` output item (first, as on the real wire) so Responses clients
    // retain it — codex replays it next turn, which chat upstreams that demand
    // `reasoning_content` passback need (utils/reasoningReplay).
    const extra = message.extra_content as WireExtra | undefined;
    const thinking = message.thinking as WireThinking | undefined ?? extra?.omnicross?.thinking;
    const reasoningContent = message.reasoning_content ?? thinking?.content;
    if ((typeof reasoningContent === 'string' && reasoningContent.length > 0) || thinking) {
      output.push({
        id: `rs_${crypto.randomUUID().replaceAll('-', '')}`,
        type: 'reasoning',
        summary: typeof reasoningContent === 'string' && reasoningContent ? [{ type: 'summary_text', text: reasoningContent }] : [],
        ...(thinking ? { extra_content: { omnicross: { thinking } } } : {}),
      });
    }
    if (typeof message.refusal === 'string') {
      contentParts.push({ type: 'refusal', refusal: message.refusal });
    }
    if (contentParts.length > 0) {
      output.push({ id: `msg_${crypto.randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: contentParts, ...(extra ? { extra_content: extra } : {}) });
    }
    if (extra && contentParts.length === 0) {
      const reasoningItem = output.find((item) => item.type === 'reasoning');
      if (reasoningItem) reasoningItem.extra_content = mergeWireExtra(reasoningItem.extra_content as WireExtra | undefined, extra);
      else output.push({ id: `msg_${crypto.randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [], extra_content: extra });
    }

    if (toolCalls.length) {
      for (const tc of toolCalls) {
        const func = tc.function as Record<string, unknown>;
        output.push(
          { ...encodeToolCallItem(
            (tc.id as string) || '',
            (func?.name as string) || '',
            typeof func?.arguments === 'string' ? func.arguments : '',
            'completed',
            codexTools
          ), ...(tc.extra_content ? { extra_content: tc.extra_content } : {}) }
        );
      }
    }
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    id: typeof data.id === 'string' && /^resp_[A-Za-z0-9_-]{1,240}$/u.test(data.id)
      ? data.id
      : `resp_${crypto.randomUUID().replaceAll('-', '')}`,
    object: 'response',
    status: choices?.[0]?.finish_reason === 'length' || choices?.[0]?.finish_reason === 'content_filter' ? 'incomplete' : 'completed',
    ...(choices?.[0]?.finish_reason === 'length' || choices?.[0]?.finish_reason === 'content_filter'
      ? { incomplete_details: { reason: choices[0].finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' } }
      : {}),
    model: data.model || 'unknown',
    output,
    usage: chatUsageToResponsesUsage(usage),
  };
}

// ============================================================================
// Streaming SSE Conversion
// ============================================================================


function convertResponseApiStreamToOpenAI(
  responseApiStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = responseApiStream.getReader();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      const id = `chatcmpl-${crypto.randomUUID()}`;
      let model = 'unknown';
      let terminal = false;
      let role = false;
      const tools = new Map<number, { index: number; arguments: string; custom: boolean }>();
      const emit = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, delta: role ? delta : { role: 'assistant', ...delta }, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`));
        role = true;
      };
      try {
        await readAnthropicSSE(reader, (raw) => {
          if (cancelled || terminal) return false;
          const event = raw as unknown as WireEvent;
          model = event.model ?? event.response?.model ?? model;
          if (event.type === 'response.output_text.delta') emit({ content: event.delta });
          else if (event.type === 'response.refusal.delta') emit({ refusal: event.delta });
          else if (event.type === 'response.reasoning_summary_text.delta') emit({ reasoning_content: event.delta });
          else if (event.type === 'response.output_item.done') {
            const item = event.item;
            if (item?.type === 'reasoning') {
              const extra = mergeWireExtra(item.extra_content, { responses: { reasoning: [item] } });
              emit({ extra_content: extra });
            } else if (item?.extra_content) {
              const tool = tools.get(event.output_index);
              if (tool) emit({ tool_calls: [{ index: tool.index, extra_content: item.extra_content }] });
              else emit({ extra_content: item.extra_content });
            }
          } else if (event.type === 'response.output_item.added') {
            const item = event.item;
            if (item?.type !== 'function_call' && item?.type !== 'custom_tool_call') return;
            const state = { index: tools.size, arguments: item.arguments ?? '', custom: item.type === 'custom_tool_call' };
            tools.set(event.output_index, state);
            emit({ tool_calls: [{
              index: state.index, id: item.call_id ?? item.id, type: 'function',
              function: { name: item.name, arguments: state.custom ? '' : state.arguments },
              ...(item.extra_content ? { extra_content: item.extra_content } : {}),
            }] });
          } else if (event.type === 'response.function_call_arguments.delta') {
            const state = tools.get(event.output_index);
            if (!state) throw new Error('Responses arguments arrived before their tool item');
            state.arguments += event.delta ?? '';
            emit({ tool_calls: [{ index: state.index, function: { arguments: event.delta ?? '' } }] });
          } else if (event.type === 'response.function_call_arguments.done') {
            const state = tools.get(event.output_index);
            if (state && typeof event.arguments === 'string' && event.arguments.startsWith(state.arguments)) {
              const remaining = event.arguments.slice(state.arguments.length);
              if (remaining) emit({ tool_calls: [{ index: state.index, function: { arguments: remaining } }] });
              state.arguments = event.arguments;
            }
          } else if (event.type === 'response.custom_tool_call_input.done') {
            const state = tools.get(event.output_index);
            if (state) emit({ tool_calls: [{ index: state.index, function: { arguments: JSON.stringify({ input: event.input ?? '' }) } }] });
          } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
            const reason = event.response?.incomplete_details?.reason;
            emit({}, event.type === 'response.incomplete'
              ? reason === 'content_filter' ? 'content_filter' : 'length'
              : tools.size ? 'tool_calls' : 'stop', responsesUsageToChatUsage(event.response?.usage));
            terminal = true;
          } else if (event.type === 'error' || event.type === 'response.failed') {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              error: event.response?.error ?? event.error ?? { message: event.message ?? 'Response failed', code: event.code },
            })}\n\n`));
            terminal = true;
          }
          if (terminal) return false;
        });
        if (cancelled) return;
        if (!terminal) throw new Error('Responses stream ended before a terminal event');
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}

/**
 * Convert OpenAI CC SSE stream → Response API SSE stream
 */
function convertOpenAIStreamToResponseApi(
  openaiStream: ReadableStream<Uint8Array>,
  codexTools?: CodexToolState,
  dsmlArmed = false
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = openaiStream.getReader();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
      let sequence = 0;
      let model = 'unknown';
      let finish: string | undefined;
      let usage: Record<string, unknown> | undefined;
      let failed = false;
      let salvage = dsmlArmed;
      const suppressor = new DsmlStreamSuppressor();
      const output: WireItem[] = [];
      const calls = new Map<number, { callId: string; name: string; arguments: string; outputIndex?: number; extra_content?: WireExtra }>();
      let textIndex: number | undefined;
      let reasoningIndex: number | undefined;
      let refusalIndex: number | undefined;
      const closedReasoning = new Set<number>();
      const thinkingBlocks = new Map<number, NonNullable<NonNullable<UnifiedMessage['thinking']>['blocks']>[number]>();
      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`));
      };
      const add = (item: Record<string, unknown>) => {
        const index = output.length;
        output.push(item as WireItem);
        emit({ type: 'response.output_item.added', output_index: index, item: { ...item } });
        return index;
      };
      const closeReasoning = () => {
        if (reasoningIndex === undefined) return;
        const index = reasoningIndex;
        const item = output[index];
        const part = item.summary![0];
        item.status = 'completed';
        emit({ type: 'response.reasoning_summary_text.done', item_id: item.id, output_index: index, summary_index: 0, text: part.text });
        emit({ type: 'response.reasoning_summary_part.done', item_id: item.id, output_index: index, summary_index: 0, part });
        emit({ type: 'response.output_item.done', output_index: index, item });
        closedReasoning.add(index);
        thinkingBlocks.clear();
        reasoningIndex = undefined;
      };
      const text = (delta: string, refusal = false, extra?: WireExtra) => {
        if (!delta && !extra) return;
        closeReasoning();
        if (textIndex === undefined) {
          textIndex = add({ id: `msg_${crypto.randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] });
        }
        const item = output[textIndex];
        if (extra) item.extra_content = mergeWireExtra(item.extra_content, extra);
        const content = item.content!;
        let contentIndex = refusal ? refusalIndex : content.findIndex((part) => part.type === 'output_text');
        if (contentIndex === undefined || contentIndex === -1) {
          contentIndex = content.length;
          const part = refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] };
          content.push(part);
          if (refusal) refusalIndex = contentIndex;
          emit({ type: 'response.content_part.added', item_id: item.id, output_index: textIndex, content_index: contentIndex, part: { ...part } });
        }
        const key = refusal ? 'refusal' : 'text';
        content[contentIndex][key] = (content[contentIndex][key] ?? '') + delta;
        emit({ type: refusal ? 'response.refusal.delta' : 'response.output_text.delta', item_id: item.id, output_index: textIndex, content_index: contentIndex, delta });
      };
      const openCall = (call: { callId: string; name: string; arguments: string; outputIndex?: number; extra_content?: WireExtra }, force = false) => {
        if (call.outputIndex !== undefined || !call.callId || !call.name || (!force && !call.arguments)) return;
        closeReasoning();
        call.outputIndex = add(encodeToolCallItem(call.callId, call.name, '', 'in_progress', codexTools));
        if (call.arguments && !isCustomToolCallName(call.name, codexTools)) {
          emit({ type: 'response.function_call_arguments.delta', item_id: output[call.outputIndex].id, output_index: call.outputIndex, delta: call.arguments });
        }
      };
      emit({ type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });
      try {
        await readAnthropicSSE(reader, (raw) => {
          if (cancelled) return false;
          const chunk = raw as unknown as WireEvent;
          model = chunk.model ?? model;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.error) {
            emit({ type: 'response.failed', response: { id: responseId, object: 'response', status: 'failed', error: chunk.error, output } });
            failed = true;
            return false;
          }
          if ((chunk.choices?.length ?? 0) > 1 || chunk.choices?.some(choice => choice.index !== undefined && choice.index !== 0)) {
            throw new Error('Multiple Chat candidates cannot be represented by one Responses result');
          }
          const choice = chunk.choices?.[0];
          if (!choice) return;
          const delta = choice.delta ?? {};
          const thinking = delta.thinking ?? delta.extra_content?.omnicross?.thinking;
          const reasoning = delta.reasoning_content ?? thinking?.content;
          const hasReasoning = (typeof reasoning === 'string' && reasoning.length > 0) || thinking !== undefined;
          if (hasReasoning) {
            if (reasoningIndex === undefined) {
              textIndex = undefined;
              refusalIndex = undefined;
              reasoningIndex = add({ id: `rs_${crypto.randomUUID().replaceAll('-', '')}`, type: 'reasoning', status: 'in_progress', summary: [] });
              emit({ type: 'response.reasoning_summary_part.added', item_id: output[reasoningIndex].id, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
              output[reasoningIndex].summary!.push({ type: 'summary_text', text: '' });
            }
            const item = output[reasoningIndex];
            const retained: WireThinking = item.extra_content?.omnicross?.thinking ?? { content: '', blocks: [] };
            if (delta.extra_content) item.extra_content = mergeWireExtra(item.extra_content, delta.extra_content);
            if (thinking) {
              retained.content = (retained.content ?? '') + (thinking.content ?? '');
              if (thinking.blocks) retained.blocks = thinking.blocks;
              else {
                const index = thinking.index ?? 0;
                let block = thinkingBlocks.get(index);
                if (!block) {
                  block = thinking.type === 'redacted_thinking'
                    ? { type: 'redacted_thinking', data: thinking.data ?? '' }
                    : { type: 'thinking', thinking: '' };
                  thinkingBlocks.set(index, block);
                  (retained.blocks ??= []).push(block);
                }
                if (block.type === 'thinking') {
                  block.thinking += thinking.content ?? '';
                  if (thinking.signature) block.signature = (block.signature ?? '') + thinking.signature;
                }
              }
              item.extra_content = { ...item.extra_content, omnicross: { thinking: retained } };
            }
            if (reasoning) {
              const part = item.summary![0];
              part.text = (part.text ?? '') + reasoning;
              emit({ type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: reasoningIndex, summary_index: 0, delta: reasoning });
            }
          }
          if (typeof delta.content === 'string') {
            salvage ||= isDsmlSalvageArmed(undefined, undefined, chunk.model);
            if (!salvage && hasDsmlMarkup(delta.content)) warnDsmlUnarmed(chunk.model);
            text(salvage ? suppressor.push(delta.content) : delta.content, false, hasReasoning ? undefined : delta.extra_content);
          }
          if (typeof delta.refusal === 'string') text(delta.refusal, true, hasReasoning ? undefined : delta.extra_content);
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            let call = calls.get(index);
            if (!call) {
              call = { callId: '', name: '', arguments: '' };
              calls.set(index, call);
            }
            if (typeof tc.id === 'string') call.callId = tc.id;
            if (typeof tc.function?.name === 'string') call.name += tc.function.name;
            const fragment = tc.function?.arguments ?? '';
            call.arguments += fragment;
            if (tc.extra_content) call.extra_content = mergeWireExtra(call.extra_content, tc.extra_content);
            if (!hasReasoning && !delta.content && !delta.refusal && delta.extra_content && tc === delta.tool_calls?.[0]) {
              call.extra_content = mergeWireExtra(call.extra_content, delta.extra_content);
            }
            const opened = call.outputIndex !== undefined;
            openCall(call);
            if (opened && fragment && !isCustomToolCallName(call.name, codexTools)) {
              emit({ type: 'response.function_call_arguments.delta', item_id: output[call.outputIndex!].id, output_index: call.outputIndex, delta: fragment });
            }
          }
          if (!hasReasoning && delta.content === undefined && delta.refusal === undefined && !delta.tool_calls?.length && delta.extra_content) {
            const item = output.at(-1);
            if (item) item.extra_content = mergeWireExtra(item.extra_content, delta.extra_content);
            else text('', false, delta.extra_content);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        });
        if (cancelled) return;
        if (failed) { controller.close(); return; }
        text(suppressor.flush());
        if (!finish) throw new Error('Chat stream ended before a finish reason');
        if (suppressor.capturing) {
          const recovered = salvageDsmlToolCalls(suppressor.capturedText);
          if (!calls.size && recovered.calls.length) {
            for (const [index, call] of recovered.calls.entries()) {
              const entry = { callId: dsmlCallId(call, index), name: call.name, arguments: call.arguments };
              calls.set(index, entry);
              openCall(entry);
            }
          } else if (!recovered.calls.length) text(suppressor.capturedText);
        }
        for (const call of calls.values()) {
          openCall(call, true);
          if (call.outputIndex === undefined) throw new Error('Chat tool call is missing its id or name');
          const item = encodeToolCallItem(call.callId, call.name, call.arguments, 'completed', codexTools);
          if (call.extra_content) item.extra_content = call.extra_content;
          output[call.outputIndex] = item as WireItem;
          const custom = item.type === 'custom_tool_call';
          if (custom) emit({ type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: call.outputIndex, delta: item.input });
          emit({ type: custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done', item_id: item.id, output_index: call.outputIndex, ...(custom ? { input: item.input } : { arguments: item.arguments }) });
        }
        closeReasoning();
        for (const [index, item] of output.entries()) {
          if (closedReasoning.has(index)) continue;
          if (item.type === 'message') {
            item.status = finish === 'length' || finish === 'content_filter' ? 'incomplete' : 'completed';
            for (const [contentIndex, part] of item.content!.entries()) {
              const refusal = part.type === 'refusal';
              emit({ type: refusal ? 'response.refusal.done' : 'response.output_text.done', item_id: item.id, output_index: index, content_index: contentIndex, ...(refusal ? { refusal: part.refusal } : { text: part.text }) });
              emit({ type: 'response.content_part.done', item_id: item.id, output_index: index, content_index: contentIndex, part });
            }
          }
          emit({ type: 'response.output_item.done', output_index: index, item });
        }
        const incomplete = finish === 'length' || finish === 'content_filter';
        emit({
          type: incomplete ? 'response.incomplete' : 'response.completed',
          response: { id: responseId, object: 'response', status: incomplete ? 'incomplete' : 'completed', model, output,
            ...(incomplete ? { incomplete_details: { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
            usage: chatUsageToResponsesUsage(usage) },
        });
        controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        try { await reader.cancel(); } finally { reader.releaseLock(); }
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  });
}
