/**
 * Gemini Utilities
 *
 * Core conversion utilities for Gemini API format.
 * Handles UnifiedChatRequest to Gemini Contents conversion.
 *
 * @module transformer/transformers/utils/gemini.util
 */

import type { ToolCall, UnifiedChatRequest, UnifiedMessage, UnifiedTool } from '../../types';

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
export function buildRequestBody(request: UnifiedChatRequest): GeminiRequestBody {
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

  if (request.reasoning?.effort && request.reasoning.effort !== 'none') {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
    };

    if (request.model.includes('gemini-3')) {
      generationConfig.thinkingConfig.thinkingLevel = request.reasoning.effort;
    } else {
      // Calculate thinking budget based on model
      const thinkingBudgets = request.model.includes('pro') ? [128, 32768] : [0, 24576];

      const maxTokens = request.reasoning.max_tokens;
      if (typeof maxTokens !== 'undefined') {
        let thinkingBudget: number;
        if (maxTokens >= thinkingBudgets[0] && maxTokens <= thinkingBudgets[1]) {
          thinkingBudget = maxTokens;
        } else if (maxTokens < thinkingBudgets[0]) {
          thinkingBudget = thinkingBudgets[0];
        } else {
          thinkingBudget = thinkingBudgets[1];
        }
        generationConfig.thinkingConfig.thinkingBudget = thinkingBudget;
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
  const maxTokens = request.max_tokens as number | undefined;
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

  // Convert contents to messages
  if (Array.isArray(contents)) {
    // Gemini pairs a functionResponse to its functionCall by NAME only — there
    // is no per-call id on functionResponse. Track the most-recent tool_call id
    // per function name as we walk the contents, so a functionResponse can be
    // paired back to the originating tool_call on the unified side.
    const lastToolCallIdByName = new Map<string, string>();

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
        } else if ('thoughtSignature' in part) {
          signature = part.thoughtSignature as string;
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
        const id =
          lastToolCallIdByName.get(fnName) ||
          `tool_${Math.random().toString(36).substring(2, 15)}`;
        // Gemini's functionResponse.response.result is the tool output; OpenAI
        // tool messages carry a string `content`.
        const result = fr.functionResponse.response?.result;
        const toolContent =
          typeof result === 'string' ? result : JSON.stringify(result ?? '');
        unifiedRequest.messages.push({
          role: 'tool',
          tool_call_id: id,
          content: toolContent,
        });
      }

      // Build tool_calls array from functionCall parts, remembering each call's
      // id so the following functionResponse (matched by name) can re-use it.
      const toolCalls: ToolCall[] = functionCalls.map((p) => {
        const id = p.functionCall.id || `tool_${Math.random().toString(36).substring(2, 15)}`;
        if (p.functionCall.name) {
          lastToolCallIdByName.set(p.functionCall.name, id);
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
