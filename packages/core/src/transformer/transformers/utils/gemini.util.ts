/**
 * Gemini Utilities
 *
 * Core conversion utilities for Gemini API format.
 * Handles UnifiedChatRequest to Gemini Contents conversion.
 *
 * @module transformer/transformers/utils/gemini.util
 */

import { EFFORT_RATIO, findTokenLimit } from '@omnicross/contracts/thinking-config';

import type { LLMProvider, ToolCall, UnifiedChatRequest, UnifiedMessage, UnifiedTool } from '../../types';
import {
  normalizeThinkLevel,
  resolveRequestReasoning,
  resolveTargetModelCapabilities,
} from '../../reasoning-effort';
import { getThinkLevel } from '../AnthropicTypes';

import { transformTool } from './gemini.schema';

/**
 * Gemini content part types
 */
export interface GeminiTextPart {
  text: string;
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
    name: string;
    response: { result: unknown };
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
  thinkingConfig?: {
    includeThoughts?: boolean;
    thinkingLevel?: string;
    thinkingBudget?: number;
  };
}

export interface GeminiToolConfig {
  functionCallingConfig: {
    mode?: 'auto' | 'none' | 'any';
    allowedFunctionNames?: string[];
  };
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  tools?: GeminiTool[];
  generationConfig?: GeminiGenerationConfig;
  toolConfig?: GeminiToolConfig;
}

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
  const tools: GeminiTool[] = [];

  // Convert tools to function declarations
  const functionDeclarations = request.tools
    ?.filter((tool) => tool.function.name !== 'web_search')
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

  // Handle web_search as Google Search
  const webSearch = request.tools?.find((tool) => tool.function.name === 'web_search');
  if (webSearch) {
    tools.push({ googleSearch: {} });
  }

  // Convert messages to Gemini contents
  const contents: GeminiContent[] = [];
  const toolResponses = request.messages.filter((item) => item.role === 'tool');

  request.messages
    .filter((item) => item.role !== 'tool')
    .forEach((message: UnifiedMessage) => {
      // Map roles
      let role: 'user' | 'model';
      if (message.role === 'assistant') {
        role = 'model';
      } else if (['user', 'system'].includes(message.role)) {
        role = 'user';
      } else {
        role = 'user';
      }

      const parts: GeminiPart[] = [];

      // Handle string content
      if (typeof message.content === 'string') {
        const part: GeminiTextPart = { text: message.content };
        if (message.thinking?.signature) {
          part.thoughtSignature = message.thinking.signature;
        }
        parts.push(part);
      }
      // Handle array content
      else if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (content.type === 'text') {
            parts.push({ text: content.text || '' });
          } else if (content.type === 'image_url') {
            const imageUrl = content.image_url?.url ?? '';
            if (imageUrl.startsWith('http')) {
              parts.push({
                file_data: {
                  mime_type: content.media_type,
                  file_uri: imageUrl,
                },
              });
            } else {
              // Base64 image
              const data = imageUrl.split(',').pop() || imageUrl;
              parts.push({
                inlineData: {
                  mime_type: content.media_type || 'image/png',
                  data,
                },
              });
            }
          }
        }
      }
      // Handle object content
      else if (message.content && typeof message.content === 'object') {
        const contentObj = message.content as Record<string, unknown>;
        if (contentObj.text) {
          parts.push({ text: contentObj.text as string });
        } else {
          parts.push({ text: JSON.stringify(message.content) });
        }
      }

      // Handle tool calls
      if (Array.isArray(message.tool_calls)) {
        for (let index = 0; index < message.tool_calls.length; index++) {
          const toolCall = message.tool_calls[index];
          const functionCallPart: GeminiFunctionCallPart = {
            functionCall: {
              id: toolCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`,
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments || '{}'),
            },
          };

          // Add signature only to first tool call if thinking exists
          if (index === 0 && message.thinking?.signature) {
            functionCallPart.thoughtSignature = message.thinking.signature;
          }

          parts.push(functionCallPart);
        }
      }

      // Ensure at least one part
      if (parts.length === 0) {
        parts.push({ text: '' });
      }

      contents.push({ role, parts });

      // Add tool responses after model's tool calls
      if (role === 'model' && message.tool_calls) {
        const functionResponses: GeminiFunctionResponsePart[] = message.tool_calls.map(
          (tool) => {
            const response = toolResponses.find((item) => item.tool_call_id === tool.id);
            return {
              functionResponse: {
                name: tool.function?.name ?? '',
                response: { result: response?.content },
              },
            };
          }
        );

        contents.push({
          role: 'user',
          parts: functionResponses,
        });
      }
    });

  // Build generation config
  const generationConfig: GeminiGenerationConfig = {};

  if (request.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = request.max_tokens;
  }

  const reasoning = resolveRequestReasoning(request, provider, { preserveNativeEffort });
  if (reasoning?.effort) {
    const capabilities = resolveTargetModelCapabilities(request.model, provider);
    const discreteLevels = capabilities.thinkingLevels;
    if (discreteLevels?.length) {
      if (reasoning.effort !== 'none' || discreteLevels.includes('none')) {
        generationConfig.thinkingConfig = {
          includeThoughts: reasoning.effort !== 'none',
          thinkingLevel: reasoning.effort,
        };
      }
    } else {
      const fallback = request.model.toLowerCase().includes('pro')
        ? { min: 128, max: 32768 }
        : { min: 0, max: 24576 };
      const limits = capabilities.thinkingTokenLimit ?? findTokenLimit(request.model) ?? fallback;
      if (reasoning.effort === 'none') {
        if (limits.min === 0) {
          generationConfig.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
        }
      } else {
        const calculated = Math.floor(
          (limits.max - limits.min) * EFFORT_RATIO[reasoning.effort] + limits.min,
        );
        const requestedBudget = typeof reasoning.max_tokens === 'number' &&
          Number.isFinite(reasoning.max_tokens)
          ? Math.floor(reasoning.max_tokens)
          : calculated;
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: Math.max(limits.min, Math.min(limits.max, requestedBudget)),
        };
      }
    }
  }

  const body: GeminiRequestBody = {
    contents,
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
      toolConfig.functionCallingConfig.mode = 'auto';
    } else if (request.tool_choice === 'none') {
      toolConfig.functionCallingConfig.mode = 'none';
    } else if (request.tool_choice === 'required') {
      toolConfig.functionCallingConfig.mode = 'any';
    } else if (
      typeof request.tool_choice === 'object' &&
      request.tool_choice.function?.name
    ) {
      toolConfig.functionCallingConfig.mode = 'any';
      toolConfig.functionCallingConfig.allowedFunctionNames = [
        request.tool_choice.function.name,
      ];
    }

    (body as unknown as Record<string, unknown>).toolConfig = toolConfig;
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
  const temperature = request.temperature as number | undefined;
  const stream = request.stream as boolean | undefined;
  const toolChoice = request.tool_choice as string | undefined;

  const unifiedRequest: UnifiedChatRequest = {
    messages: [],
    model,
    max_tokens: maxTokens,
    temperature,
    stream,
    tool_choice: toolChoice as UnifiedChatRequest['tool_choice'],
  };

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
  }

  // Convert contents to messages
  if (Array.isArray(contents)) {
    // Gemini pairs a functionResponse to its functionCall by NAME only — there
    // is no per-call id on functionResponse. Track the tool_call ids per
    // function name as a QUEUE as we walk the contents; Gemini delivers
    // functionResponse parts in the same order as the matching functionCall
    // parts, so shifting one id per response pairs them correctly even when the
    // model makes PARALLEL calls to the same function (two `search`, two
    // `read_file`). A plain last-wins map would mispair those.
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

      if (!content || typeof content !== 'object' || !('role' in content)) {
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
        } else if ('inlineData' in part || 'file_data' in part) {
          // Multimodal → image_url content block (mirror of buildRequestBody).
          const inline = part.inlineData as { mime_type?: string; data?: string } | undefined;
          const fileData = part.file_data as { mime_type?: string; file_uri?: string } | undefined;
          if (inline?.data) {
            const mime = inline.mime_type || 'image/png';
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mime};base64,${inline.data}` },
              media_type: mime,
            });
          } else if (fileData?.file_uri) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: fileData.file_uri },
              media_type: fileData.mime_type,
            });
          }
        } else if ('text' in part) {
          // Gemini encodes reasoning as `{text, thought:true}` parts.
          if (part.thought === true) {
            thinkingText += (part.text as string) ?? '';
          } else {
            textParts.push(part as unknown as GeminiTextPart);
          }
        }
      }

      // Emit one unified `role:"tool"` message per functionResponse (Gemini
      // delivers them bundled inside a single user content, but the unified
      // format expects each tool result as its own message).
      for (const fr of functionResponses) {
        const fnName = fr.functionResponse.name ?? '';
        const queue = toolCallIdsByName.get(fnName);
        const id =
          queue && queue.length > 0
            ? (queue.shift() as string)
            : `tool_${Math.random().toString(36).substring(2, 15)}`;
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
        unifiedRequest.messages.push({
          role: 'tool',
          tool_call_id: id,
          content: toolContent,
        });
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

      // Compose the unified message content. Prefer a plain string for
      // text-only contents (the common case); otherwise build a content array.
      let messageContent: string | null | Array<Record<string, unknown>>;
      if (contentParts.length > 0) {
        messageContent = [
          ...textParts.map((p) => ({ type: 'text', text: p.text })),
          ...contentParts,
        ];
      } else {
        messageContent = textParts.map((p) => p.text).join('\n') || null;
      }

      const message: UnifiedMessage = {
        role,
        content: messageContent as unknown as UnifiedMessage['content'],
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      if (signature || thinkingText) {
        message.thinking = { content: thinkingText || '', signature };
      }
      unifiedRequest.messages.push(message);
    }
  }

  // Convert tools
  if (Array.isArray(tools)) {
    unifiedRequest.tools = [];
    for (const tool of tools) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const funcDecl of tool.functionDeclarations) {
          unifiedRequest.tools.push({
            type: 'function',
            function: {
              name: funcDecl.name,
              description: funcDecl.description ?? '',
              parameters: (funcDecl.parameters ??
                funcDecl.parametersJsonSchema ??
                {}) as unknown as UnifiedTool['function']['parameters'],
            },
          });
        }
      }
    }
  }

  return unifiedRequest;
}
