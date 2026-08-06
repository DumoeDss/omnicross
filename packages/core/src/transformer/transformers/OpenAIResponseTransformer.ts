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
  input: Array<ResponseApiInput | Record<string, unknown>>;
  /** The public Responses API's system prompt (codex sends a `developer` item instead). */
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  reasoning?: { effort: string; summary?: string };
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
    _context: TransformerContext
  ): Promise<Record<string, unknown>> {
    // ChatGPT's codex backend (official chatgpt.com OR any third-party relay)
    // is a PRIVATE Responses variant: it REQUIRES `store:false`, REQUIRES typed
    // `input_text` parts (rejects bare-string content), REJECTS
    // `max_output_tokens`, and omits Content-Type on its SSE stream. Relays do
    // NOT carry a discoverable url token, so codex can't be reliably told from
    // public-OpenAI by url. Default to the codex-private shape because the
    // public OpenAI Responses API ACCEPTS it too (`input_text` is the standard
    // part type, `store:false` is legal, omitting `max_output_tokens` falls
    // back to the upstream default) — works for all providers without a url
    // guess. If a future public provider must honor max_output_tokens, add an
    // opt-out flag then.
    const input: Array<Record<string, unknown>> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        const sysText = typeof msg.content === 'string' ? msg.content : flattenContent(msg.content);
        input.push({
          role: 'developer',
          content: [{ type: 'input_text', text: sysText }],
        });
      } else if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : '',
        });
      } else {
        const text = typeof msg.content === 'string' ? msg.content : flattenContent(msg.content);
        const entry: Record<string, unknown> = {
          role: msg.role,
          content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text }],
        };
        // Include tool_calls as function_call items
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          // For Response API, tool calls are separate output items
          // Push the assistant text first, then each function_call
          input.push(entry);
          for (const tc of msg.tool_calls) {
            // codex's function_call ITEM carries TWO ids: `id` (the item id,
            // MUST begin with 'fc_') and `call_id` (the call handle a later
            // function_call_output references). The unified tool_call only has
            // the call_id, so synthesize an fc_ item id from it — codex
            // correlates call↔output by `call_id`, never by the item id.
            const callId = tc.id;
            const itemId = callId.startsWith('fc_')
              ? callId
              : `fc_${callId.replace(/^(call_|fc_)/, '')}`;
            input.push({
              type: 'function_call',
              id: itemId,
              call_id: callId,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
          continue;
        }
        input.push(entry);
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      // codex's backend REQUIRES `stream:true` (it 400s with "Stream must be
      // set to true" otherwise). Always force it; a non-streaming CLIENT is
      // served by aggregating the SSE upstream of the wire (the ingress buffers
      // it into a single message), not by asking codex for a non-streaming reply.
      stream: true,
      // `store:false` is required by the codex backend and accepted by the
      // public Responses API (which defaults to store:true). Always set it so
      // codex relays (no discoverable url token) work without configuration.
      store: false,
      // `max_output_tokens` is intentionally omitted: the codex backend rejects
      // it, and the public API falls back to its default when absent. If a
      // public provider ever needs it honored, gate that on an opt-out flag.
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    // Map reasoning config
    if (request.reasoning?.effort && request.reasoning.effort !== 'none') {
      body.reasoning = { effort: request.reasoning.effort, summary: 'auto' };
    }

    // Map tools
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));
    }

    // Map tool_choice
    if (request.tool_choice) {
      if (typeof request.tool_choice === 'string') {
        body.tool_choice = request.tool_choice;
      } else if (typeof request.tool_choice === 'object' && 'function' in request.tool_choice) {
        body.tool_choice = { type: 'function', name: request.tool_choice.function.name };
      }
    }

    // HOST-ROOT-ABSOLUTE BY DESIGN: `new URL('/v1/responses', baseUrl)` keeps only
    // the base's ORIGIN and replaces the WHOLE path with `/v1/responses`. This is
    // correct for the public OpenAI / ChatGPT Responses endpoints (their path IS
    // `/v1/responses` at the host root). Consumers whose provider base carries a
    // PATH PREFIX (e.g. opencode-zen `…/zen/v1/responses`, codex
    // `…/backend-api/codex/responses`) MUST NOT use this `config.url` — it would
    // drop the prefix. Such consumers prefer their own complete `upstreamUrl`
    // instead (see `usesResponsesChain` in `anthropicSubscriptionPlan.ts` /
    // `SubscriptionDispatcher.ts`, which gate the Responses chain onto `upstreamUrl`).
    const url = new URL('/v1/responses', provider.baseUrl);

    return { body, config: { url } };
  }

  /**
   * Transform Response API request → unified format
   */
  async transformRequestOut(
    request: unknown,
    _context: TransformerContext
  ): Promise<UnifiedChatRequest> {
    const req = request as ResponseApiRequest;
    const messages: UnifiedMessage[] = [];
    // codex ships its tool declarations inside an `additional_tools` INPUT item
    // rather than the top-level `tools` field; collected as we walk the input.
    let codexTools: CodexToolDeclarations | null = null;

    // The public Responses API carries the system prompt in `instructions`
    // (codex instead sends it as a `developer` message item). Dropping it lost
    // the caller's entire system prompt silently.
    const instructions = typeof req.instructions === 'string' ? req.instructions.trim() : '';
    if (instructions) {
      messages.push({ role: 'system', content: instructions });
    }

    if (req.input) {
      for (const item of req.input) {
        const entry = item as Record<string, unknown>;
        const itemType = typeof entry.type === 'string' ? entry.type : undefined;

        if (itemType && SKIPPED_INPUT_ITEM_TYPES.has(itemType)) continue;

        // codex's tool declarations. Merged into `result.tools` below; the item
        // itself carries `role:'developer'` with no content and must not become
        // a message.
        if (itemType === 'additional_tools') {
          codexTools = collectCodexTools(entry);
          continue;
        }

        // A custom tool RESULT. Same array-vs-string `output` shape as
        // `function_call_output`, so it gets the same flattening.
        if (itemType === 'custom_tool_call_output') {
          messages.push({
            role: 'tool',
            content: flattenContent(entry.output),
            tool_call_id: (entry.call_id as string) || undefined,
          });
          continue;
        }

        // A custom tool CALL. codex carries the payload as free-form text in
        // `input`; the chat wire wants JSON arguments, so it is wrapped in the
        // `{input:…}` envelope declared by CUSTOM_TOOL_PARAMETERS. The response
        // encoder unwraps it again.
        if (itemType === 'custom_tool_call') {
          const toolCall = {
            id: ((entry.call_id ?? entry.id) as string) || '',
            type: 'function' as const,
            function: {
              name: (entry.name as string) || '',
              arguments: JSON.stringify({
                input: typeof entry.input === 'string' ? entry.input : '',
              }),
            },
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') {
            (last.tool_calls ??= []).push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
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
            content: flattenContent(entry.output),
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
          const toolCall = {
            id: ((entry.call_id ?? entry.id) as string) || '',
            type: 'function' as const,
            function: {
              name: (entry.name as string) || '',
              arguments: typeof entry.arguments === 'string' ? entry.arguments : '',
            },
          };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') {
            (last.tool_calls ??= []).push(toolCall);
          } else {
            messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
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
        const text = flattenContent(entry.content);
        // Defensive: an item with a role but no usable text would otherwise emit
        // a `{"role":"system"}` message with `content: undefined`, which some
        // upstreams reject outright.
        if (!text) continue;
        if (role === 'developer' || role === 'system') {
          messages.push({ role: 'system', content: text });
        } else if (role === 'user' || role === 'assistant') {
          messages.push({ role, content: text });
        }
      }
    }

    const result: UnifiedChatRequest = {
      messages,
      model: req.model,
      max_tokens: req.max_output_tokens,
      temperature: req.temperature,
      stream: req.stream,
    };

    if (req.reasoning?.effort) {
      result.reasoning = {
        effort: req.reasoning.effort as 'low' | 'medium' | 'high',
        enabled: true,
      };
    }

    // Tools come from BOTH the standard top-level `tools` field and codex's
    // `additional_tools` input item; a client may use either.
    const tools: UnifiedTool[] = [];
    if (req.tools?.length) {
      tools.push(
        ...req.tools
          .filter((t) => t.type === 'function')
          .map((t) => ({
            type: 'function' as const,
            function: {
              name: (t.name as string) || '',
              description: (t.description as string) || '',
              parameters: (t.parameters || {}) as UnifiedTool['function']['parameters'],
            },
          }))
      );
    }
    if (codexTools?.tools.length) {
      const declared = new Set(tools.map((t) => t.function.name));
      tools.push(...codexTools.tools.filter((t) => !declared.has(t.function.name)));
    }
    if (tools.length) result.tools = tools;

    // Thread the custom-tool / namespace state to the response encoder. `meta`
    // is internal-only and never serialised into the outbound body.
    if (codexTools?.customToolNames.length || Object.keys(codexTools?.toolNamespaces ?? {}).length) {
      result.meta = {
        ...result.meta,
        codexTools: {
          ...(codexTools!.customToolNames.length
            ? { customToolNames: codexTools!.customToolNames }
            : {}),
          ...(Object.keys(codexTools!.toolNamespaces).length
            ? { toolNamespaces: codexTools!.toolNamespaces }
            : {}),
        },
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
    const contentType = response.headers.get('Content-Type') ?? '';

    // ChatGPT's codex backend OMITS Content-Type on SSE streams, so a header
    // check alone misroutes them into the JSON branch (which throws
    // "Unexpected token 'e'" on the leading `event:` line). Peek the first
    // chunk to detect an SSE frame when the header is absent.
    let isSse = contentType.includes('text/event-stream');
    if (!isSse && response.body) {
      const peek = response.clone();
      try {
        const reader = peek.body!.getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        const head = value ? new TextDecoder().decode(value).trimStart() : '';
        isSse = head.startsWith('event:') || head.startsWith('data:');
      } catch {
        /* treat as non-SSE on peek failure */
      }
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
    const contentType = response.headers.get('Content-Type') ?? '';
    // Request-scoped codex protocol state, recorded by `transformRequestOut`
    // and threaded here on `context.req` by `executeResponseChain`. Absent for
    // non-codex clients, which simply get plain `function_call` items.
    const codexTools = (context?.req as UnifiedChatRequest | undefined)?.meta?.codexTools;

    if (contentType.includes('text/event-stream')) {
      if (!response.body) {
        throw new Error('Stream response body is null');
      }
      return new Response(convertOpenAIStreamToResponseApi(response.body, codexTools), {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    const data = await response.json();
    return new Response(JSON.stringify(convertOpenAIJsonToResponseApi(data, codexTools)), {
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
 * - `reasoning` — provider-internal, and `encrypted_content` under `store:false`.
 * - `agent_message` — codex multi-agent inbound message; no chat role fits it.
 *
 * `additional_tools`, `custom_tool_call` and `custom_tool_call_output` are NOT
 * dropped: see `collectCodexTools` and the custom-tool branches in
 * `transformRequestOut`.
 */
const SKIPPED_INPUT_ITEM_TYPES = new Set(['reasoning', 'agent_message']);

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
    if (parsed && typeof parsed === 'object' && typeof parsed.input === 'string') {
      return parsed.input;
    }
  } catch {
    /* not valid JSON — fall through to the raw text */
  }
  return argumentsJson;
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
function encodeToolCallItem(
  callId: string,
  name: string,
  argumentsJson: string,
  status: 'in_progress' | 'completed',
  codexTools: CodexToolState,
): Record<string, unknown> {
  const bareId = callId.replace(/^(call_|fc_|ctc_)/, '');

  if (codexTools?.customToolNames?.includes(name)) {
    return {
      id: `ctc_${bareId}`,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name,
      input: unwrapCustomToolInput(argumentsJson),
    };
  }

  const namespace = codexTools?.toolNamespaces?.[name];
  return {
    id: callId.startsWith('fc_') ? callId : `fc_${bareId}`,
    type: 'function_call',
    status,
    call_id: callId,
    name,
    ...(namespace ? { namespace } : {}),
    arguments: argumentsJson,
  };
}

/** What `collectCodexTools` recovers from an `additional_tools` item. */
interface CodexToolDeclarations {
  tools: UnifiedTool[];
  /** Names declared `type:'custom'` — re-encoded as `custom_tool_call` on the way back. */
  customToolNames: string[];
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
function collectCodexTools(entry: Record<string, unknown>): CodexToolDeclarations {
  const result: CodexToolDeclarations = { tools: [], customToolNames: [], toolNamespaces: {} };

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

      if (tool.type === 'custom') {
        result.customToolNames.push(name);
        result.tools.push({
          type: 'function',
          function: {
            name,
            description,
            parameters: CUSTOM_TOOL_PARAMETERS as unknown as UnifiedTool['function']['parameters'],
          },
        });
      } else if (tool.type === 'function') {
        result.tools.push({
          type: 'function',
          function: {
            name,
            description,
            parameters: (tool.parameters || {}) as UnifiedTool['function']['parameters'],
          },
        });
      } else {
        continue;
      }

      if (namespace) result.toolNamespaces[name] = namespace;
    }
  };

  visit(entry.tools);
  return result;
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
  let textContent = '';
  const toolCalls: Array<Record<string, unknown>> = [];

  const output = data.output as Array<Record<string, unknown>> | undefined;
  if (output) {
    for (const item of output) {
      if (item.type === 'message') {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const part of content) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              textContent += part.text;
            }
          }
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id || item.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: item.name,
            arguments:
              typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments || {}),
          },
        });
      }
    }
  }

  const usage = data.usage as Record<string, number> | undefined;
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || 'unknown',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens || 0,
          completion_tokens: usage.output_tokens || 0,
          total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        }
      : undefined,
  };
}

function convertOpenAIJsonToResponseApi(
  data: Record<string, unknown>,
  codexTools?: CodexToolState
): Record<string, unknown> {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const output: Array<Record<string, unknown>> = [];

  if (message) {
    const contentParts: Array<Record<string, unknown>> = [];
    if (message.content) {
      contentParts.push({ type: 'output_text', text: message.content });
    }
    if (contentParts.length > 0) {
      output.push({ type: 'message', role: 'assistant', content: contentParts });
    }

    const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const func = tc.function as Record<string, unknown>;
        output.push(
          encodeToolCallItem(
            (tc.id as string) || '',
            (func?.name as string) || '',
            typeof func?.arguments === 'string' ? func.arguments : '',
            'completed',
            codexTools
          )
        );
      }
    }
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    id: data.id || `resp_${Date.now()}`,
    object: 'response',
    status: 'completed',
    model: data.model || 'unknown',
    output,
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          total_tokens:
            usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        }
      : undefined,
  };
}

// ============================================================================
// Streaming SSE Conversion
// ============================================================================

/**
 * Convert Response API SSE stream → OpenAI CC SSE stream
 */
function convertResponseApiStreamToOpenAI(
  responseApiStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    start: async (controller) => {
      const reader = responseApiStream.getReader();
      let buffer = '';
      let isClosed = false;
      const messageId = `chatcmpl-${Date.now()}`;
      let model = 'unknown';
      let hasEmittedRole = false;
      // True once a codex function_call event is seen in this stream, so the
      // terminal `response.completed` chunk carries `finish_reason:"tool_calls"`
      // (matching the OpenAI-chat protocol — a tool-call turn is NOT a `stop`).
      let hasToolCalls = false;

      const safeEnqueue = (str: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(str));
          } catch {
            isClosed = true;
          }
        }
      };

      const emitChunk = (choices: unknown[], usage?: unknown) => {
        const chunk: Record<string, unknown> = {
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices,
        };
        if (usage) chunk.usage = usage;
        safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (isClosed) break;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);
              model = event.model || event.response?.model || model;

              switch (event.type) {
                case 'response.output_text.delta':
                  if (event.delta) {
                    if (!hasEmittedRole) {
                      emitChunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
                      hasEmittedRole = true;
                    }
                    emitChunk([{ index: 0, delta: { content: event.delta }, finish_reason: null }]);
                  }
                  break;

                case 'response.reasoning_summary_text.delta':
                  if (event.delta) {
                    emitChunk([{
                      index: 0,
                      delta: { thinking: { content: event.delta } },
                      finish_reason: null,
                    }]);
                  }
                  break;

                case 'response.output_item.added': {
                  // codex emits a `function_call` output item when the model
                  // decides to call a tool. Translate it into an OpenAI-chat
                  // `tool_calls` delta so step 2 (AnthropicOpenAIToAnthropicStream)
                  // can map it to an Anthropic `tool_use` block. Without this,
                  // the tool call is silently dropped and the client gets an
                  // empty assistant turn.
                  const item = event.item;
                  if (item?.type !== 'function_call') break;
                  if (!hasEmittedRole) {
                    emitChunk([{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }]);
                    hasEmittedRole = true;
                  }
                  hasToolCalls = true;
                  emitChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: event.output_index ?? 0,
                        id: item.call_id,
                        type: 'function',
                        function: { name: item.name, arguments: '' },
                      }],
                    },
                    finish_reason: null,
                  }]);
                  break;
                }

                case 'response.function_call_arguments.delta': {
                  // codex streams the function-call arguments token-by-token;
                  // concatenate into the matching tool_call's `arguments`.
                  hasToolCalls = true;
                  emitChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: event.output_index ?? 0,
                        function: { arguments: event.delta ?? '' },
                      }],
                    },
                    finish_reason: null,
                  }]);
                  break;
                }

                case 'response.completed': {
                  const resp = event.response;
                  const respUsage = resp?.usage;
                  const usage = respUsage
                    ? {
                        prompt_tokens: respUsage.input_tokens || 0,
                        completion_tokens: respUsage.output_tokens || 0,
                        total_tokens:
                          (respUsage.input_tokens || 0) + (respUsage.output_tokens || 0),
                      }
                    : undefined;
                  // A tool-call turn finishes with `tool_calls` (matching the
                  // OpenAI-chat protocol); a plain-text turn finishes `stop`.
                  emitChunk([{ index: 0, delta: {}, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }], usage);
                  safeEnqueue('data: [DONE]\n\n');
                  break;
                }

                case 'error':
                  emitChunk([{
                    index: 0,
                    delta: { content: `[Error: ${event.error?.message || 'Unknown error'}]` },
                    finish_reason: 'stop',
                  }]);
                  break;

                default:
                  break;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      } catch (e) {
        if (!isClosed) controller.error(e);
      } finally {
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
        reader.releaseLock();
      }
    },
  });
}

/**
 * Convert OpenAI CC SSE stream → Response API SSE stream
 */
function convertOpenAIStreamToResponseApi(
  openaiStream: ReadableStream<Uint8Array>,
  codexTools?: CodexToolState
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    start: async (controller) => {
      const reader = openaiStream.getReader();
      let buffer = '';
      let isClosed = false;
      let accumulatedContent = '';
      let model = 'unknown';
      const responseId = `resp_${Date.now()}`;
      // The assistant text message occupies output index 0 (tool calls follow at
      // 1+). Codex builds its message item from `response.output_item.added` and
      // finalizes it on `response.output_item.done`; without that lifecycle the
      // text deltas arrive but nothing renders (`last_agent_message` null). Emit
      // the item lazily on the first content delta and close it at finish,
      // mirroring the real Responses streaming wire format.
      const messageId = `msg_${Date.now()}`;
      let messageItemAdded = false;
      // Accumulate tool calls (keyed by OpenAI tool_call index) so the terminal
      // `response.completed` carries them as `function_call` output items, and
      // stream them as `function_call_arguments.delta` events — mirroring codex's
      // own wire format. Without this, a tool call from an OpenAI-chat upstream
      // (e.g. a BYO provider behind `/v1/responses`) is silently dropped.
      const toolCalls = new Map<
        number,
        { callId: string; name: string; arguments: string; isCustom: boolean }
      >();
      // Output index 0 is the assistant `message` (text); tool calls follow at 1+.
      const toolOutputIndex = new Map<number, number>();
      let nextOutputIndex = 1;

      const safeEnqueue = (str: string) => {
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(str));
          } catch {
            isClosed = true;
          }
        }
      };

      const emitEvent = (event: Record<string, unknown>) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      };

      emitEvent({
        type: 'response.created',
        response: { id: responseId, status: 'in_progress' },
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (isClosed) break;
            if (!line.startsWith('data:')) continue;

            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data);
              const choice = chunk.choices?.[0];
              model = chunk.model || model;

              if (!choice) continue;

              if (choice.delta?.content) {
                if (!messageItemAdded) {
                  messageItemAdded = true;
                  emitEvent({
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: {
                      id: messageId,
                      type: 'message',
                      role: 'assistant',
                      status: 'in_progress',
                      content: [],
                    },
                  });
                }
                accumulatedContent += choice.delta.content;
                emitEvent({
                  type: 'response.output_text.delta',
                  output_index: 0,
                  content_index: 0,
                  delta: choice.delta.content,
                });
              }

              // Reasoning reaches Unified under EITHER spelling, depending on
              // which format transformer decoded the upstream: a Responses
              // upstream yields `thinking.content` (emitted by this class's own
              // decoder), while an OpenAI-chat upstream carries the wire's
              // `reasoning_content` verbatim — `openai` is a pass-through on the
              // response side, since on the chat ingress Unified IS the client
              // wire. Read both so a Codex client sees reasoning from a chat
              // upstream too. (This used to work only because DeepseekTransformer
              // renamed the field, which silently broke the Anthropic encoder.)
              const reasoningDelta =
                choice.delta?.thinking?.content ??
                (choice.delta as { reasoning_content?: string } | undefined)?.reasoning_content;
              if (reasoningDelta) {
                emitEvent({
                  type: 'response.reasoning_summary_text.delta',
                  delta: reasoningDelta,
                });
              }

              // Tool calls → codex-style function_call streaming events.
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls as Array<Record<string, unknown>>) {
                  const tcIndex = typeof tc['index'] === 'number' ? tc['index'] : 0;
                  const func = (tc['function'] ?? {}) as Record<string, unknown>;
                  let entry = toolCalls.get(tcIndex);
                  if (!entry) {
                    const callId = typeof tc['id'] === 'string' ? (tc['id'] as string) : `call_${Date.now()}_${tcIndex}`;
                    const name = typeof func['name'] === 'string' ? (func['name'] as string) : '';
                    entry = {
                      callId,
                      name,
                      arguments: '',
                      isCustom: codexTools?.customToolNames?.includes(name) ?? false,
                    };
                    toolCalls.set(tcIndex, entry);
                    const outIdx = nextOutputIndex++;
                    toolOutputIndex.set(tcIndex, outIdx);
                    // A codex `custom` tool opens a `custom_tool_call` item, a
                    // regular one a `function_call` — the encoder picks, and
                    // synthesizes the id prefix each protocol requires.
                    emitEvent({
                      type: 'response.output_item.added',
                      output_index: outIdx,
                      item: encodeToolCallItem(callId, name, '', 'in_progress', codexTools),
                    });
                  }
                  const argsFragment = typeof func['arguments'] === 'string' ? (func['arguments'] as string) : '';
                  if (argsFragment) {
                    entry.arguments += argsFragment;
                    // A custom tool's payload is the `input` STRING nested inside
                    // the arguments JSON; it cannot be recovered from a partial
                    // fragment (`{"input":"const a` is not parseable), so its
                    // delta is emitted once at finish instead of per fragment.
                    if (!entry.isCustom) {
                      emitEvent({
                        type: 'response.function_call_arguments.delta',
                        output_index: toolOutputIndex.get(tcIndex),
                        delta: argsFragment,
                      });
                    }
                  }
                }
              }

              if (choice.finish_reason) {
                const output: Array<Record<string, unknown>> = [];
                if (messageItemAdded) {
                  emitEvent({
                    type: 'response.output_text.done',
                    output_index: 0,
                    content_index: 0,
                    text: accumulatedContent,
                  });
                  const messageItem = {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: accumulatedContent }],
                  };
                  emitEvent({
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: messageItem,
                  });
                  output.push(messageItem);
                }
                for (const [tcIndex, entry] of toolCalls) {
                  const outIdx = toolOutputIndex.get(tcIndex);
                  const item = encodeToolCallItem(
                    entry.callId,
                    entry.name,
                    entry.arguments,
                    'completed',
                    codexTools
                  );
                  // The custom-tool input was withheld during streaming (see the
                  // delta branch); emit it now as one delta + done so codex still
                  // receives the input-stream lifecycle it expects.
                  if (entry.isCustom) {
                    emitEvent({
                      type: 'response.custom_tool_call_input.delta',
                      output_index: outIdx,
                      delta: item.input,
                    });
                    emitEvent({
                      type: 'response.custom_tool_call_input.done',
                      output_index: outIdx,
                      input: item.input,
                    });
                  }
                  output.push(item);
                  // The streamed `added` event carried status in_progress; mark done.
                  emitEvent({
                    type: 'response.output_item.done',
                    output_index: outIdx,
                    item,
                  });
                }
                emitEvent({
                  type: 'response.completed',
                  response: {
                    id: responseId,
                    status: 'completed',
                    model,
                    output,
                    usage: chunk.usage
                      ? {
                          input_tokens: chunk.usage.prompt_tokens || 0,
                          output_tokens: chunk.usage.completion_tokens || 0,
                          total_tokens: chunk.usage.total_tokens || 0,
                        }
                      : undefined,
                  },
                });
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      } catch (e) {
        if (!isClosed) controller.error(e);
      } finally {
        if (!isClosed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
        reader.releaseLock();
      }
    },
  });
}
