/**
 * Gemini Utilities
 *
 * Core conversion utilities for Gemini API format.
 * Handles UnifiedChatRequest to Gemini Contents conversion.
 *
 * @module transformer/transformers/utils/gemini.util
 */

import type { LLMProvider, ToolCall, UnifiedChatRequest, UnifiedMessage, UnifiedTool } from '../../types';
import { applyAlias, normalizeModelId } from '@omnicross/contracts/canonical-models';
import {
  extractReasoningIntent,
  normalizeThinkLevel,
  resolveReasoningPlan,
} from '../../reasoning-effort';
import { getThinkLevel } from '../AnthropicTypes';
import { recordDroppedField } from '../../transformWarnings';

import { schemaToJsonSchema, transformTool } from './gemini.schema';

/**
 * Gemini content part types
 */
export interface GeminiTextPart {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
}

export interface GeminiFunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
    parts?: Array<{ inlineData: { mimeType: string; data: string } }>;
  };
}

export interface GeminiInlineDataPart {
  inlineData: {
    mime_type: string;
    data: string;
  };
}

export interface GeminiFileDataPart {
  file_data: {
    mime_type?: string;
    file_uri: string;
  };
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiInlineDataPart
  | GeminiFileDataPart;

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiTool {
  functionDeclarations?: Array<{
    name: string;
    description?: string;
    parametersJsonSchema?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  }>;
  googleSearch?: Record<string, unknown>;
}

export interface GeminiGenerationConfig {
  maxOutputTokens?: number;
  candidateCount?: number;
  temperature?: number;
  responseJsonSchema?: Record<string, unknown>;
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingLevel?: string;
    thinkingBudget?: number;
  };
  // Image output (chat-inline-images): image models require
  // responseModalities to be requested explicitly.
  responseModalities?: string[];
  // Structured output (Responses `text.format` → chat `response_format`):
  // Gemini spells it responseMimeType + responseSchema (an OpenAPI-schema
  // subset; the caller's JSON schema passes through as-is, best-effort).
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  // R7 (claude-api-transform-fidelity): decoded sampling/stop knobs.
  stopSequences?: string[];
  topP?: number;
  topK?: number;
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    mode?: 'auto' | 'none' | 'any' | 'AUTO' | 'NONE' | 'ANY' | 'VALIDATED';
    allowedFunctionNames?: string[];
  };
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
  toolConfig?: GeminiToolConfig;
  [key: string]: unknown;
}


type NativeGemini = {
  extra_content?: { google?: { parts?: GeminiPart[]; request?: Record<string, unknown>; thought_signature?: string } };
};
/**
 * Build Gemini request body from UnifiedChatRequest
 *
 * @param request - Unified chat request
 * @returns Gemini-formatted request body
 */
export function buildRequestBody(
  request: UnifiedChatRequest,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
  preserveNativeEffort = false,
): GeminiRequestBody {
  const nativeRequest = (request as UnifiedChatRequest & NativeGemini).extra_content?.google?.request;
  const nativeThinking = (nativeRequest?.generationConfig as GeminiGenerationConfig | undefined)?.thinkingConfig;
  const modelId = applyAlias(normalizeModelId(request.model));
  if ((request as UnifiedChatRequest & { _serverSideTools?: unknown[] })._serverSideTools?.length) {
    throw new Error('Anthropic server-side tools cannot be represented as Gemini function declarations');
  }
  const tools: GeminiTool[] = [];

  // Convert tools to function declarations
  const functionDeclarations = request.tools
    ?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parametersJsonSchema: tool.function.parameters,
    }));

  if (functionDeclarations?.length) {
    tools.push(
      transformTool({
        functionDeclarations,
      }) as GeminiTool
    );
  }


  const contents: GeminiContent[] = [];
  const systemParts: GeminiPart[] = [];
  const calls = new Map<string, ToolCall>();
  for (const message of request.messages) {
    const nativeParts = (message as UnifiedMessage & NativeGemini).extra_content?.google?.parts;
    if (message.role === 'tool') {
      const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
      if (!call && !nativeParts) {
        throw new Error(`Gemini tool result has no matching call: ${message.tool_call_id ?? ''}`);
      }
      let result: unknown = message.content;
      const media: Array<{ inlineData: { mimeType: string; data: string } }> = [];
      if (Array.isArray(message.content)) {
        const text: string[] = [];
        for (const part of message.content) {
          if (part.type === 'text') text.push(part.text);
          else if (part.type === 'image_url') {
            const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(part.image_url.url);
            if (!dataUrl) throw new Error('Gemini function responses require inline base64 image data');
            media.push({ inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } });
          }
        }
        result = text.join('\n');
      }
      const parts: GeminiPart[] = nativeParts ?? [{
        functionResponse: {
          id: message.tool_call_id,
          name: call!.function.name,
          response: message.is_error ? { error: result } : { result },
          ...(media.length ? { parts: media } : {}),
        },
      }];
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user' && previous.parts.every((part) => 'functionResponse' in part) &&
          parts.every((part) => 'functionResponse' in part)) {
        previous.parts.push(...parts);
      } else {
        contents.push({ role: 'user', parts });
      }
      continue;
    }
    for (const call of message.tool_calls ?? []) calls.set(call.id, call);
    const parts: GeminiPart[] = [];
    if (nativeParts) {
      parts.push(...nativeParts);
    } else {
      const reasoning = (message as UnifiedMessage & { reasoning_content?: string }).reasoning_content ?? message.thinking?.content;
      if (reasoning) parts.push({ text: reasoning, thought: true });
      if (typeof message.content === 'string' && message.content !== '') {
        parts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === 'text') {
            parts.push({ text: content.text });
          } else if (content.type === 'image_url') {
            const url = content.image_url.url;
            const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
            if (dataUrl) {
              parts.push({ inlineData: { mime_type: dataUrl[1], data: dataUrl[2] } });
            } else if (/^(https?:|gs:)/.test(url)) {
              parts.push({ file_data: { mime_type: content.media_type, file_uri: url } });
            } else {
              throw new Error('Gemini image input requires a base64 data URL or file URI');
            }
          }
        }
      }
      for (const toolCall of message.tool_calls ?? []) {
        const signature = (toolCall as ToolCall & NativeGemini).extra_content?.google?.thought_signature;
        const args: unknown = JSON.parse(toolCall.function.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Gemini function arguments must be an object');
        parts.push({
          functionCall: {
            id: toolCall.id,
            name: toolCall.function.name,
            args: args as Record<string, unknown>,
          },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
    }
    if (message.role === 'system') {
      systemParts.push(...parts);
    } else if (parts.length) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
  }

  // Build generation config
  const generationConfig: GeminiGenerationConfig = {};

  if (request.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (request.n !== undefined) generationConfig.candidateCount = request.n;

  // R7 (claude-api-transform-fidelity): decoded sampling/stop knobs — all
  // conditionally present, so a request that omits them builds the exact same
  // body as before this change.
  if (request.stop !== undefined && request.stop.length > 0) {
    generationConfig.stopSequences = request.stop;
  }
  // Argon ignores these sampling controls. Audit the loss when converting;
  // native same-format generationConfig remains intact below.
  // https://ai.google.dev/gemini-api/docs/generate-content/latest-model
  if (modelId === 'gemini-4-argon' && !nativeRequest?.generationConfig) {
    if (request.temperature !== undefined) recordDroppedField(request, 'temperature', 'gemini');
    if (request.top_p !== undefined) recordDroppedField(request, 'top_p', 'gemini');
    if (request.top_k !== undefined) recordDroppedField(request, 'top_k', 'gemini');
  } else {
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    if (request.top_k !== undefined) generationConfig.topK = request.top_k;
  }
  if (request.metadata_user_id !== undefined) {
    recordDroppedField(request, 'metadata_user_id', 'gemini');
  }

  // Structured output: the chat wire's response_format (mapped from the
  // Responses `text.format`) becomes Gemini's responseMimeType + responseSchema.
  if (request.response_format?.type === 'json_schema' && request.response_format.json_schema?.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = request.response_format.json_schema.schema;
  } else if (request.response_format?.type === 'json_object') {
    generationConfig.responseMimeType = 'application/json';
  }

  const reasoningPlan = nativeThinking ? undefined : resolveReasoningPlan({
    intent: extractReasoningIntent(request),
    model: request.model,
    provider,
    target: 'gemini',
    requestMaxTokens: request.max_tokens,
    preserveNativeEffort,
  });
  if (reasoningPlan?.kind === 'level') {
    generationConfig.thinkingConfig = {
      includeThoughts: reasoningPlan.enabled,
      thinkingLevel: reasoningPlan.effort,
    };
  } else if (reasoningPlan?.kind === 'budget') {
    generationConfig.thinkingConfig = {
      includeThoughts: reasoningPlan.enabled,
      thinkingBudget: reasoningPlan.budgetTokens,
    };
  }

  // Image models (chat-inline-images D6): a gemini id containing `-image` is a
  // canonical image-chat model — image output must be requested explicitly via
  // responseModalities. Inject only when the caller did not carry it; non-image
  // models build the exact same body as before (byte-identical requests).
  if (
    !generationConfig.responseModalities &&
    typeof request.model === 'string' &&
    request.model.startsWith('gemini') &&
    request.model.includes('-image')
  ) {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
  }

  const body: GeminiRequestBody = {
    contents,
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    tools: tools.length > 0 ? tools : undefined,
    generationConfig:
      Object.keys(generationConfig).length > 0 ? generationConfig : undefined,
  };

  // Add tool config if tool_choice is specified
  if (request.tool_choice) {
    const toolConfig: GeminiToolConfig = {
      functionCallingConfig: {},
    };

    if (request.tool_choice === 'auto') {
      toolConfig.functionCallingConfig.mode = 'AUTO';
    } else if (request.tool_choice === 'none') {
      toolConfig.functionCallingConfig.mode = 'NONE';
    } else if (request.tool_choice === 'required') {
      toolConfig.functionCallingConfig.mode = 'ANY';
    } else if (
      typeof request.tool_choice === 'object' &&
      request.tool_choice.function?.name
    ) {
      toolConfig.functionCallingConfig.mode = 'ANY';
      toolConfig.functionCallingConfig.allowedFunctionNames = [
        request.tool_choice.function.name,
      ];
    } else {
      throw new Error(`Unsupported Gemini tool choice: ${JSON.stringify(request.tool_choice)}`);
    }

    body.toolConfig = toolConfig;
  }

  if (nativeRequest) {
    Object.assign(body, nativeRequest);
    if (nativeRequest.generationConfig) body.generationConfig = nativeRequest.generationConfig as GeminiGenerationConfig;
  }

  return body;
}

/**
 * Transform Gemini request format to UnifiedChatRequest
 * (For incoming requests to Gemini endpoint)
 *
 * Round-trips Gemini's `contents[].parts[]` shape into the unified
 * OpenAI-chat-like message list:
 *   - `{role:"model", parts:[{functionCall}, {text}]}`  → assistant message
 *     with `tool_calls` + text content.
 *   - `{role:"user", parts:[{functionResponse}]}`        → one `role:"tool"`
 *     message per `functionResponse` (Gemini matches function calls by NAME,
 *     not id, so the previous assistant turn's id is re-used when available).
 *   - `{text, thought:true}` and `thoughtSignature`      → `thinking` block.
 *   - `inlineData` / `file_data` parts                   → `image_url` parts.
 *
 * @param request - Gemini-formatted request
 * @returns Unified chat request
 */
export function transformRequestOut(request: Record<string, unknown>): UnifiedChatRequest {
  const contents = request.contents as GeminiContent[] | undefined;
  const tools = request.tools as GeminiTool[] | undefined;
  const model = request.model as string;
  const generationConfig = request.generationConfig as GeminiGenerationConfig | undefined;
  const maxTokens = generationConfig?.maxOutputTokens ?? request.max_tokens as number | undefined;
  const temperature = generationConfig?.temperature ?? request.temperature as number | undefined;
  const stream = request.stream as boolean | undefined;
  const toolChoice = request.tool_choice as string | undefined;

  const unifiedRequest: UnifiedChatRequest = {
    messages: [],
    model,
    max_tokens: maxTokens,
    n: generationConfig?.candidateCount,
    temperature,
    stream,
    tool_choice: toolChoice as UnifiedChatRequest['tool_choice'],
  };
  const nativeRequest = Object.fromEntries(Object.entries(request).filter(([key]) =>
    ['generationConfig', 'tools', 'toolConfig', 'safetySettings', 'cachedContent', 'labels'].includes(key)));
  (unifiedRequest as UnifiedChatRequest & NativeGemini).extra_content = { google: { request: nativeRequest } };
  unifiedRequest.top_p = generationConfig?.topP;
  unifiedRequest.top_k = generationConfig?.topK;
  unifiedRequest.stop = generationConfig?.stopSequences;
  const schema = generationConfig?.responseJsonSchema ??
    (generationConfig?.responseSchema ? schemaToJsonSchema(generationConfig.responseSchema) : undefined);
  if (schema) unifiedRequest.response_format = { type: 'json_schema', json_schema: { schema } };
  else if (generationConfig?.responseMimeType === 'application/json') unifiedRequest.response_format = { type: 'json_object' };
  const calling = (request.toolConfig as GeminiToolConfig | undefined)?.functionCallingConfig;
  const mode = calling?.mode?.toUpperCase();
  if (mode === 'NONE') unifiedRequest.tool_choice = 'none';
  else if (mode === 'AUTO') unifiedRequest.tool_choice = 'auto';
  else if (mode === 'ANY') {
    unifiedRequest.tool_choice = calling?.allowedFunctionNames?.length === 1
      ? { type: 'function', function: { name: calling.allowedFunctionNames[0] } }
      : 'required';
  }
  const system = (request.systemInstruction ?? request.system_instruction) as { parts?: GeminiTextPart[] } | undefined;
  if (system?.parts) {
    const message: UnifiedMessage & NativeGemini = {
      role: 'system',
      content: system.parts.map((part) => part.text ?? '').join('\n'),
      extra_content: { google: { parts: system.parts } },
    };
    unifiedRequest.messages.push(message);
  }

  const thinkingConfig = generationConfig?.thinkingConfig;
  const discreteEffort = normalizeThinkLevel(thinkingConfig?.thinkingLevel);
  if (discreteEffort) {
    unifiedRequest.reasoning = {
      effort: discreteEffort,
      enabled: discreteEffort !== 'none',
    };
  } else if (typeof thinkingConfig?.thinkingBudget === 'number' &&
      Number.isFinite(thinkingConfig.thinkingBudget) && thinkingConfig.thinkingBudget >= 0) {
    const budget = thinkingConfig.thinkingBudget;
    unifiedRequest.reasoning = budget === 0
      ? { effort: 'none', enabled: false, max_tokens: 0 }
      : { effort: getThinkLevel(budget), enabled: true, max_tokens: budget };
  } else if (thinkingConfig?.thinkingBudget === -1) {
    unifiedRequest.reasoning = { enabled: true };
  }

  // Convert contents to messages
  if (Array.isArray(contents)) {
    // Explicit IDs take precedence; otherwise pair by name and occurrence.
    const toolCallIdsByName = new Map<string, string[]>();

    for (const content of contents) {
      // Bare-string shorthand (some clients send `contents: ["hi"]`).
      if (typeof content === 'string') {
        unifiedRequest.messages.push({ role: 'user', content });
        continue;
      }

      // Tolerate a lone part sent directly instead of a `{role, parts}` wrapper.
      if (
        content &&
        typeof content === 'object' &&
        'text' in content &&
        typeof (content as { text: unknown }).text === 'string' &&
        !('parts' in content)
      ) {
        unifiedRequest.messages.push({
          role: 'user',
          content: (content as { text: string }).text || null,
        });
        continue;
      }

      if (!content || typeof content !== 'object' || !('parts' in content)) {
        continue;
      }

      const geminiContent = content as GeminiContent;
      const isModel = geminiContent.role === 'model';
      const role: 'user' | 'assistant' = isModel ? 'assistant' : 'user';
      const parts = geminiContent.parts ?? [];

      // Partition parts by kind so each kind maps to its unified equivalent.
      const functionResponses: GeminiFunctionResponsePart[] = [];
      const functionCalls: GeminiFunctionCallPart[] = [];
      const textParts: GeminiTextPart[] = [];
      const contentParts: Array<Record<string, unknown>> = [];
      let thinkingText = '';
      let signature: string | undefined;

      for (const part of parts as unknown as Array<Record<string, unknown>>) {
        // `thoughtSignature` is an AUXILIARY field: Gemini attaches it to ANY
        // part kind (text, functionCall, ...) on a thinking turn. Capture it
        // FIRST and non-exclusively, then dispatch the part's primary kind, so a
        // `{text, thoughtSignature}` part keeps BOTH its text and its signature
        // (buildRequestBody produces exactly this shape for assistant turns with
        // thinking, so the round-trip must preserve it).
        if ('thoughtSignature' in part) {
          signature = part.thoughtSignature as string;
        }
        if ('functionResponse' in part) {
          functionResponses.push(part as unknown as GeminiFunctionResponsePart);
        } else if ('functionCall' in part) {
          functionCalls.push(part as unknown as GeminiFunctionCallPart);
        } else if ('inlineData' in part || 'inline_data' in part || 'file_data' in part || 'fileData' in part) {
          const inline = (part.inlineData ?? part.inline_data) as { mimeType?: string; mime_type?: string; data?: string } | undefined;
          const fileData = (part.fileData ?? part.file_data) as { mimeType?: string; mime_type?: string; fileUri?: string; file_uri?: string } | undefined;
          if (inline?.data) {
            const mime = inline.mimeType ?? inline.mime_type ?? 'image/png';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${inline.data}` },
              media_type: mime,
            });
          } else if (fileData?.fileUri || fileData?.file_uri) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: fileData.fileUri ?? fileData.file_uri },
              media_type: fileData.mimeType ?? fileData.mime_type,
            });
          }
        } else if ('text' in part) {
          // Gemini encodes reasoning as `{text, thought:true}` parts.
          if (part.thought === true) {
            thinkingText += (part.text as string) ?? '';
          } else {
            textParts.push(part as unknown as GeminiTextPart);
            contentParts.push({ type: 'text', text: part.text });
          }
        }
      }

      // Emit one unified `role:"tool"` message per functionResponse (Gemini
      // delivers them bundled inside a single user content, but the unified
      // format expects each tool result as its own message).
      for (const fr of functionResponses) {
        const fnName = fr.functionResponse.name ?? '';
        const queue = toolCallIdsByName.get(fnName);
        const explicitId = fr.functionResponse.id;
        const id = explicitId ?? queue?.shift() ?? `tool_${Math.random().toString(36).substring(2, 15)}`;
        if (explicitId && queue?.includes(explicitId)) queue.splice(queue.indexOf(explicitId), 1);
        // Gemini's functionResponse.response.result is the tool output; OpenAI
        // tool messages carry a string `content`. The forward direction always
        // writes `{ result }`, but external SDKs sometimes use other shapes
        // (`{ response: { content } }`), so fall back to the whole response.
        const response = fr.functionResponse.response;
        const result = response?.result;
        const toolContent =
          typeof result === 'string'
            ? result
            : result !== undefined
              ? JSON.stringify(result)
              : response !== undefined
                ? JSON.stringify(response)
                : '';
        const media = fr.functionResponse.parts?.map((part) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` },
          media_type: part.inlineData.mimeType,
        }));
        const toolMessage: UnifiedMessage & NativeGemini = {
          role: 'tool',
          tool_call_id: id,
          content: media?.length ? [{ type: 'text', text: toolContent }, ...media] : toolContent,
          ...(response && 'error' in response ? { is_error: true } : {}),
          extra_content: { google: { parts: [fr] } },
        };
        unifiedRequest.messages.push(toolMessage);
      }

      // Build tool_calls array from functionCall parts, queuing each call's id
      // by function name so the following functionResponses (matched by name,
      // in order) can re-use them.
      const toolCalls: ToolCall[] = functionCalls.map((p) => {
        const id = p.functionCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`;
        if (p.functionCall.name) {
          const arr = toolCallIdsByName.get(p.functionCall.name) ?? [];
          arr.push(id);
          toolCallIdsByName.set(p.functionCall.name, arr);
        }
        return {
          id,
          type: 'function',
          function: {
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          },
          ...(p.thoughtSignature ? { extra_content: { google: { thought_signature: p.thoughtSignature } } } : {}),
        };
      });

      // If this content held ONLY functionResponses, the tool messages above are
      // the whole story — do not also emit an empty user message.
      const onlyToolResults =
        functionResponses.length > 0 &&
        textParts.length === 0 &&
        functionCalls.length === 0 &&
        contentParts.length === 0 &&
        !thinkingText &&
        !signature;
      if (onlyToolResults) continue;

      // Keep multimodal content in original order; plain text needs no array.
      const hasMedia = contentParts.some((part) => part.type !== 'text');
      const messageContent = hasMedia
        ? contentParts
        : textParts.map((part) => part.text).join('') || null;

      const message: UnifiedMessage & NativeGemini = {
        role,
        content: messageContent as unknown as UnifiedMessage['content'],
        extra_content: { google: { parts: functionResponses.length ? parts.filter((part) => !('functionResponse' in part)) : parts } },
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      if (thinkingText) message.thinking = { content: thinkingText };
      unifiedRequest.messages.push(message);
    }
  }

  // Convert tools
  if (Array.isArray(tools)) {
    unifiedRequest.tools = [];
    for (const tool of tools) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const funcDecl of tool.functionDeclarations) {
          if (mode === 'ANY' && calling?.allowedFunctionNames?.length &&
              !calling.allowedFunctionNames.includes(funcDecl.name)) continue;
          unifiedRequest.tools.push({
            type: 'function',
            function: {
              name: funcDecl.name,
              description: funcDecl.description ?? '',
              parameters: (funcDecl.parametersJsonSchema ??
                (funcDecl.parameters ? schemaToJsonSchema(funcDecl.parameters) : {})) as unknown as UnifiedTool['function']['parameters'],
            },
          });
        }
      }
    }
  }

  return unifiedRequest;
}
