/**
 * Gemini Utilities
 *
 * Core conversion utilities for Gemini API format.
 * Handles UnifiedChatRequest to Gemini Contents conversion.
 *
 * @module transformer/transformers/utils/gemini.util
 */

import type { UnifiedChatRequest, UnifiedMessage, UnifiedTool } from '../../types';

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
    for (const content of contents) {
      if (typeof content === 'string') {
        unifiedRequest.messages.push({
          role: 'user',
          content,
        });
      } else if ('text' in content && typeof content.text === 'string') {
        unifiedRequest.messages.push({
          role: 'user',
          content: content.text || null,
        });
      } else if ('role' in content && content.role === 'user') {
        const geminiContent = content as GeminiContent;
        unifiedRequest.messages.push({
          role: 'user',
          content:
            geminiContent.parts?.map((part) => ({
              type: 'text' as const,
              text: (part as GeminiTextPart).text || '',
            })) || [],
        });
      } else if ((content as GeminiContent).role === 'model') {
        unifiedRequest.messages.push({
          role: 'assistant',
          content:
            (content as GeminiContent).parts?.map((part) => ({
              type: 'text' as const,
              text: (part as GeminiTextPart).text || '',
            })) || [],
        });
      }
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
              parameters: (funcDecl.parameters ?? {}) as unknown as UnifiedTool['function']['parameters'],
            },
          });
        }
      }
    }
  }

  return unifiedRequest;
}
