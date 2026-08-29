/**
 * AnthropicRequestBuilder - Build an Anthropic Messages API request body
 * from a unified (OpenAI-shaped) request.
 *
 * Internal helper of `./AnthropicConversion`; do not import the facade here.
 *
 * BETA HEADER NOTE (claude-api-protocol-fidelity, R5 — explicit declaration):
 * the TRANSLATION path (unified → target wire, this builder and its callers)
 * does NOT forward the caller's `anthropic-beta` header. Cross-wire the beta
 * flags have no meaning the target can act on, and the capabilities they gate
 * (context_management, files, etc.) do not exist on the translated wire —
 * corresponding request fields the upstream rejects come back as explicit
 * errors rather than being silently downgraded. Only the SAME-FORMAT
 * (Anthropic→Anthropic verbatim) path forwards/merges beta flags; see
 * `runSameFormatFetch` / `buildAnthropicBeta`.
 *
 * @module transformer/transformers/AnthropicRequestBuilder
 */

import { resolveAnthropicMaxTokens } from '../../anthropicMaxTokens';
import type { LLMProvider, TextContent, UnifiedChatRequest } from '../types';
import {
  extractReasoningIntent,
  resolveReasoningPlan,
} from '../reasoning-effort';

import type {
  AnthropicContent,
  AnthropicMessage,
  AnthropicThinkingContent,
  AnthropicToolResultContent,
} from './AnthropicTypes';

/**
 * Build an Anthropic Messages API request body from a unified request.
 */
export function buildAnthropicRequestBody(
  request: UnifiedChatRequest,
  provider?: Pick<LLMProvider, 'modelConfigs'>,
): Record<string, unknown> {
  let systemContent: string | Array<{ type: 'text'; text: string; cache_control?: unknown }> | undefined;
  const anthropicMessages: AnthropicMessage[] = [];

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];

    // System message → extract to top-level field
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        systemContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        systemContent = msg.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => ({
            type: 'text' as const,
            text: c.text,
            ...(c.cache_control ? { cache_control: c.cache_control } : {}),
          }));
      }
      continue;
    }

    // Assistant message → content blocks (text + tool_use + thinking)
    if (msg.role === 'assistant') {
      const content: AnthropicContent[] = [];

      // Thinking block (must precede text/tool_use in Anthropic format).
      // `signature` is only included when the upstream returned one — some
      // Anthropic-compat providers (e.g. Xiaomi MiMo) emit thinking blocks
      // without it, and a literal `signature: undefined` would still serialise
      // as a missing field but it's clearer to omit it explicitly.
      if (msg.thinking?.content) {
        const block: AnthropicThinkingContent = {
          type: 'thinking',
          thinking: msg.thinking.content,
        };
        if (msg.thinking.signature) {
          block.signature = msg.thinking.signature;
        }
        content.push(block);
      }

      if (msg.content) {
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((c): c is TextContent => c.type === 'text').map(c => c.text).join('\n');
        if (text) {
          content.push({ type: 'text', text });
        }
      }

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown>;
          try {
            input = typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function.arguments as unknown as Record<string, unknown>);
          } catch {
            input = { text: tc.function.arguments || '' };
          }
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }

      anthropicMessages.push({
        role: 'assistant',
        content: content.length > 0 ? content : '',
      });
      continue;
    }

    // Tool result messages → group consecutive into single user message
    if (msg.role === 'tool') {
      const toolResults: AnthropicToolResultContent[] = [];
      let j = i;
      while (j < request.messages.length && request.messages[j].role === 'tool') {
        const t = request.messages[j];
        toolResults.push({
          type: 'tool_result',
          tool_use_id: t.tool_call_id || '',
          content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content),
          ...(t.cache_control ? { cache_control: t.cache_control } : {}),
        });
        j++;
      }
      anthropicMessages.push({ role: 'user', content: toolResults });
      i = j - 1; // -1 because the for loop will increment
      continue;
    }

    // User message
    if (typeof msg.content === 'string') {
      anthropicMessages.push({ role: 'user', content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Convert image_url → Anthropic image source
      const content: AnthropicContent[] = msg.content.map((part) => {
        if (part.type === 'image_url') {
          const url = part.image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: match[1], data: match[2] },
              };
            }
          }
          return {
            type: 'image' as const,
            source: { type: 'url' as const, url },
          };
        }
        return { type: 'text' as const, text: part.text };
      });
      anthropicMessages.push({ role: 'user', content });
    }
  }

  // Build Anthropic request body
  const body: Record<string, unknown> = {
    model: request.model,
    messages: anthropicMessages,
    // Anthropic requires this field, so an absent caller cap must resolve to
    // the model's real ceiling — NOT a small constant, which would silently
    // truncate long responses (and corrupt tool-call JSON mid-stream).
    // See `resolveAnthropicMaxTokens`.
    max_tokens: resolveAnthropicMaxTokens(request.model, request.max_tokens),
    stream: request.stream ?? false,
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  // R7 symmetric backfill (claude-api-transform-fidelity): decoded hub fields
  // return to their Anthropic spellings — all conditional so an absent field
  // changes nothing vs before this change.
  if (request.stop !== undefined && request.stop.length > 0) {
    body.stop_sequences = request.stop;
  }
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.top_k !== undefined) body.top_k = request.top_k;
  if (request.metadata_user_id !== undefined) {
    body.metadata = { user_id: request.metadata_user_id };
  }

  if (systemContent !== undefined) {
    body.system = systemContent;
  }

  // Convert tools: function.parameters → input_schema
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters,
    }));
  }

  // Restore server-side tools (web_search_20250305, code_execution, etc.)
  // that were preserved during transformRequestOut round-trip
  const serverSideTools = (request as unknown as Record<string, unknown>)._serverSideTools as
    Array<Record<string, unknown>> | undefined;
  if (serverSideTools?.length) {
    body.tools = [...(body.tools as Array<Record<string, unknown>> || []), ...serverSideTools];
  }

  // Convert tool_choice
  if (request.tool_choice) {
    if (typeof request.tool_choice === 'string') {
      if (request.tool_choice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (request.tool_choice !== 'none') {
        body.tool_choice = { type: request.tool_choice };
      }
    } else if (typeof request.tool_choice === 'object' && 'function' in request.tool_choice) {
      body.tool_choice = { type: 'tool', name: request.tool_choice.function.name };
    }
  }

  // Convert reasoning immediately before the Anthropic wire boundary. Models
  // declaring discrete levels use adaptive thinking; older targets retain the
  // bounded budget_tokens contract.
  const reasoningPlan = resolveReasoningPlan({
    intent: extractReasoningIntent(request),
    model: request.model,
    provider,
    target: 'anthropic',
    requestMaxTokens: request.max_tokens,
  });
  if (reasoningPlan?.kind === 'level' && reasoningPlan.enabled) {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: reasoningPlan.effort };
  } else if (reasoningPlan?.kind === 'budget' && reasoningPlan.enabled) {
    body.thinking = { type: 'enabled', budget_tokens: reasoningPlan.budgetTokens };
    // Legacy extended thinking requires temperature=1. Adaptive thinking does not.
    body.temperature = 1;
  }

  return body;
}
