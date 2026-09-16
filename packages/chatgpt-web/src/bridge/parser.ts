/**
 * parser.ts — normalize a Codex Responses request body into CodexParsedRequest.
 *
 * Trimmed port of codex-chatgpt-web's responses/parser.ts: the same input-item
 * taxonomy (message roles, reasoning siblings, function/custom tool calls and
 * outputs, agent_message, compaction markers, tool_search), minus the local
 * previous_response_id replay cache (this bridge rejects previous_response_id
 * instead — Codex runs with disable_response_storage and sends full context).
 *
 * @module @omnicross/chatgpt-web/bridge/parser
 */

import { compactionItemToText, isOnePixelPngDataUrl } from './compaction';
import type {
  CodexAgentMessage,
  CodexAssistantMessage,
  CodexContentPart,
  CodexMessage,
  CodexParsedRequest,
  CodexRequestOptions,
  CodexTextContent,
  CodexThinkingContent,
  CodexTool,
  CodexToolCall,
} from './types';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type InputBlock =
  | { type: 'input_text'; text: string }
  | { type: 'text'; text: string }
  | { type: 'input_image'; image_url?: string; file_id?: string; detail?: string }
  | { type: 'input_file'; file_id?: string; filename?: string };

function normalizeImageDetail(detail: string): string {
  return detail === 'original' ? 'high' : detail;
}

function inputContentParts(blocks: unknown[] | string | undefined): string | CodexContentPart[] {
  if (typeof blocks === 'string') return blocks;
  if (!blocks) return [];
  const parts: CodexContentPart[] = [];
  for (const raw of blocks) {
    const block = raw as InputBlock;
    if (block.type === 'input_text' || block.type === 'text') {
      parts.push({ type: 'text', text: (block as { text: string }).text });
    } else if (block.type === 'input_image') {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      if (b.image_url) {
        parts.push({
          type: 'image',
          imageUrl: b.image_url,
          ...(b.detail ? { detail: normalizeImageDetail(b.detail) } : {}),
        });
      } else {
        parts.push({ type: 'text', text: `[image: ${b.file_id ?? '?'}]` });
      }
    } else if (block.type === 'input_file') {
      const ref =
        (block as { file_id?: string; filename?: string }).file_id ??
        (block as { filename?: string }).filename ??
        '?';
      parts.push({ type: 'text', text: `[file: ${ref}]` });
    }
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

type OutputBlock = { type: 'output_text'; text: string } | { type: 'text'; text: string } | { type: 'refusal'; refusal: string };

function outputTextOf(blocks: unknown[] | string | undefined): CodexTextContent[] {
  if (typeof blocks === 'string') return blocks.length > 0 ? [{ type: 'text', text: blocks }] : [];
  if (!blocks) return [];
  const out: CodexTextContent[] = [];
  for (const raw of blocks) {
    const b = raw as OutputBlock;
    if (b.type === 'output_text' || b.type === 'text') out.push({ type: 'text', text: (b as { text: string }).text });
    else if (b.type === 'refusal') out.push({ type: 'text', text: `[refusal: ${(b as { refusal: string }).refusal}]` });
  }
  return out;
}

/** Tool-call output content: keeps images structured, joins plain text. */
function outputToToolResultContent(output: string | unknown[] | undefined): string | CodexContentPart[] {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  const parts: CodexContentPart[] = [];
  let hasImage = false;
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if (raw['type'] === 'output_text' || raw['type'] === 'text' || raw['type'] === 'input_text') {
      if (typeof raw['text'] === 'string') parts.push({ type: 'text', text: raw['text'] });
    } else if (raw['type'] === 'refusal' && typeof raw['refusal'] === 'string') {
      parts.push({ type: 'text', text: `[refusal: ${raw['refusal']}]` });
    } else if (raw['type'] === 'input_image' && typeof raw['image_url'] === 'string') {
      parts.push({
        type: 'image',
        imageUrl: raw['image_url'],
        ...(typeof raw['detail'] === 'string' ? { detail: normalizeImageDetail(raw['detail']) } : {}),
      });
      hasImage = true;
    } else if (raw['type'] === 'encrypted_content') {
      parts.push({ type: 'text', text: '[encrypted content omitted]' });
    }
  }
  if (!hasImage) return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return parts;
}

function findToolById(messages: CodexMessage[], callId: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (const part of m.content) {
      if (part.type === 'toolCall' && part.id === callId) return { name: part.name, namespace: part.namespace };
    }
  }
  return { name: '' };
}

const DEFAULT_FUNCTION_NAMESPACE = 'functions';

function normalizedToolNamespace(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value !== DEFAULT_FUNCTION_NAMESPACE
    ? value
    : undefined;
}

function buildTools(tools: unknown[] | undefined): CodexTool[] {
  if (!tools) return [];
  const out: CodexTool[] = [];
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    out.push({
      name: String(t['name']),
      description: (t['description'] as string) ?? '',
      parameters: (t['parameters'] ?? {}) as Record<string, unknown>,
      ...(namespace ? { namespace } : {}),
    });
  };
  const pushFreeform = (t: Record<string, unknown>) => {
    out.push({
      name: String(t['name']),
      description: (t['description'] as string) ?? '',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description:
              'Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope.',
          },
        },
        required: ['input'],
      },
      freeform: true,
    });
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t['type'] === 'function' && typeof t['name'] === 'string') {
      pushFn(t);
    } else if (t['type'] === 'namespace' && Array.isArray(t['tools'])) {
      const ns = normalizedToolNamespace(t['name']);
      for (const inner of t['tools']) {
        if (!isObj(inner) || typeof inner['name'] !== 'string') continue;
        if (inner['type'] === 'function') pushFn(inner, ns);
        else if (t['name'] === DEFAULT_FUNCTION_NAMESPACE && inner['type'] === 'custom') pushFreeform(inner);
      }
    } else if (t['type'] === 'custom' && typeof t['name'] === 'string') {
      pushFreeform(t);
    } else if (t['type'] === 'tool_search') {
      out.push({
        name: 'tool_search',
        description: (t['description'] as string) ?? 'Search for additional tools to load for the next turn.',
        parameters: (isObj(t['parameters'])
          ? t['parameters']
          : {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query for tools to load.' },
                limit: { type: 'number', description: 'Maximum number of tools to return.' },
              },
              required: ['query'],
            }) as Record<string, unknown>,
        toolSearch: true,
      });
    } else if (typeof t['name'] === 'string' && t['type'] !== 'web_search' && t['type'] !== 'image_generation') {
      pushFn(t);
    }
    // Server-side tools (web_search, image_generation) are intentionally dropped.
  }
  return out;
}

function ensureAssistantPlaceholder(messages: CodexMessage[], modelId: string, now: number): CodexAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') return last;
  const placeholder: CodexAssistantMessage = { role: 'assistant', content: [], model: modelId, timestamp: now };
  messages.push(placeholder);
  return placeholder;
}

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Parse one Responses request body. Throws on structurally invalid input. */
export function parseRequest(body: unknown): CodexParsedRequest {
  if (!isObj(body)) throw new Error('responses parse error: request body must be a JSON object');
  if (typeof body['model'] !== 'string' || body['model'].length === 0) {
    throw new Error('responses parse error: model is required');
  }
  if (body['previous_response_id'] !== undefined && body['previous_response_id'] !== null) {
    throw new Error(
      'previous_response_id is not supported by the ChatGPT Web bridge; run Codex with ' +
        'disable_response_storage (the omnicross launch wiring sets it) and send full context',
    );
  }
  const data = body;
  const modelId = String(data['model']);
  const now = Date.now();
  const messages: CodexMessage[] = [];
  const systemPrompt: string[] = [];
  const pendingReasoning: CodexThinkingContent[] = [];
  const loadedToolSpecs: unknown[] = [];
  let compactionRequest = false;

  const assistantHolderWithReasoning = (): CodexAssistantMessage => {
    const holder = ensureAssistantPlaceholder(messages, modelId, now);
    if (pendingReasoning.length > 0) {
      holder.content.push(...pendingReasoning.splice(0, pendingReasoning.length));
    }
    return holder;
  };

  if (typeof data['instructions'] === 'string' && data['instructions'].length > 0) {
    systemPrompt.push(data['instructions']);
  }

  if (typeof data['input'] === 'string') {
    messages.push({ role: 'user', content: data['input'], timestamp: now });
  } else if (Array.isArray(data['input'])) {
    for (const item of data['input']) {
      if (!isObj(item)) continue;
      const effectiveType = (item['type'] as string | undefined) ?? ('role' in item ? 'message' : undefined);

      if (effectiveType === 'compaction_trigger') {
        compactionRequest = true;
        continue;
      }

      if (effectiveType === 'additional_tools') {
        if (Array.isArray(item['tools'])) loadedToolSpecs.push(...(item['tools'] as unknown[]));
        continue;
      }

      if (effectiveType === 'compaction' || effectiveType === 'compaction_summary' || effectiveType === 'context_compaction') {
        const encrypted = item['encrypted_content'];
        if (effectiveType === 'context_compaction' && typeof encrypted !== 'string') continue;
        pendingReasoning.length = 0;
        messages.push({
          role: 'user',
          content: compactionItemToText(typeof encrypted === 'string' ? encrypted : undefined),
          timestamp: now,
        });
        continue;
      }

      if (effectiveType === 'agent_message') {
        pendingReasoning.length = 0;
        const content = inputContentParts(item['content'] as unknown[] | string | undefined);
        const message: CodexAgentMessage = {
          role: 'agentMessage',
          ...(typeof item['author'] === 'string' ? { author: item['author'] } : {}),
          ...(typeof item['recipient'] === 'string' ? { recipient: item['recipient'] } : {}),
          content,
          timestamp: now,
        };
        messages.push(message);
        continue;
      }

      if (effectiveType === 'message') {
        switch (item['role']) {
          case 'system': {
            pendingReasoning.length = 0;
            const text = inputContentParts(item['content'] as unknown[] | string | undefined);
            const flat = typeof text === 'string' ? text : text.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case 'user':
          case 'developer': {
            pendingReasoning.length = 0;
            messages.push({
              role: item['role'],
              content: inputContentParts(item['content'] as unknown[] | string | undefined),
              timestamp: now,
            });
            break;
          }
          case 'assistant': {
            const parts = outputTextOf(item['content'] as unknown[] | string | undefined);
            const phase = item['phase'];
            messages.push({
              role: 'assistant',
              content:
                pendingReasoning.length > 0
                  ? [...pendingReasoning.splice(0, pendingReasoning.length), ...parts]
                  : parts,
              ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
              model: modelId,
              timestamp: now,
            });
            break;
          }
        }
        continue;
      }

      if (effectiveType === 'reasoning') {
        const summary = Array.isArray(item['summary'])
          ? (item['summary'] as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
          : '';
        const content = Array.isArray(item['content'])
          ? (item['content'] as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
          : '';
        const text = summary || content;
        if (text.length > 0) {
          if (pendingReasoning.length > 0) {
            const previous = pendingReasoning[pendingReasoning.length - 1];
            previous.thinking = `${previous.thinking}\n${text}`;
          } else {
            pendingReasoning.push({ type: 'thinking', thinking: text });
          }
        }
        continue;
      }

      if (effectiveType === 'function_call') {
        let args: Record<string, unknown> = {};
        const rawArgs = typeof item['arguments'] === 'string' ? item['arguments'].trim() : '';
        if (rawArgs) {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (isObj(parsed)) args = parsed;
          } catch {
            // Tolerate non-JSON arguments rather than poisoning the session.
          }
        }
        const toolCall: CodexToolCall = {
          type: 'toolCall',
          id: String(item['call_id'] ?? ''),
          name: String(item['name'] ?? ''),
          arguments: args,
          ...(item['namespace'] ? { namespace: String(item['namespace']) } : {}),
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === 'custom_tool_call') {
        assistantHolderWithReasoning().content.push({
          type: 'toolCall',
          id: String(item['call_id'] ?? ''),
          name: String(item['name'] ?? ''),
          arguments: { input: typeof item['input'] === 'string' ? item['input'] : '' },
        });
        continue;
      }

      if (effectiveType === 'local_shell_call') {
        const callId = (item['call_id'] ?? item['id']) as string | undefined;
        if (callId) {
          const action = isObj(item['action']) ? item['action'] : {};
          const command = Array.isArray(action['command']) ? (action['command'] as string[]) : [];
          assistantHolderWithReasoning().content.push({
            type: 'toolCall',
            id: callId,
            name: 'shell',
            arguments: command.length > 0 ? { command } : {},
          });
        }
        continue;
      }

      if (effectiveType === 'web_search_call') {
        pendingReasoning.length = 0;
        continue;
      }

      if (effectiveType === 'tool_search_call') {
        assistantHolderWithReasoning().content.push({
          type: 'toolCall',
          id: String(item['call_id'] ?? item['id'] ?? ''),
          name: 'tool_search',
          arguments: isObj(item['arguments']) ? item['arguments'] : {},
        });
        continue;
      }

      if (effectiveType === 'tool_search_output') {
        pendingReasoning.length = 0;
        const specs = Array.isArray(item['tools']) ? (item['tools'] as Record<string, unknown>[]) : [];
        loadedToolSpecs.push(...specs);
        const wireNames: string[] = [];
        for (const spec of specs) {
          if (spec['type'] === 'namespace' && Array.isArray(spec['tools'])) {
            const namespace = normalizedToolNamespace(spec['name']);
            for (const inner of spec['tools'] as Record<string, unknown>[]) {
              if (typeof inner['name'] === 'string') {
                wireNames.push(namespace ? `${namespace}__${inner['name']}` : inner['name']);
              }
            }
          } else if (typeof spec['name'] === 'string') {
            wireNames.push(spec['name']);
          }
        }
        const failed =
          typeof item['status'] === 'string' && item['status'] !== 'completed' && item['status'] !== 'success';
        messages.push({
          role: 'toolResult',
          toolCallId: String(item['call_id'] ?? ''),
          toolName: 'tool_search',
          content:
            failed && wireNames.length === 0
              ? `Tool search failed (status: ${String(item['status'])}).`
              : wireNames.length
                ? `Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${wireNames.join(', ')}.`
                : 'Tool search returned no tools.',
          isError: failed && wireNames.length === 0,
          timestamp: now,
        });
        continue;
      }

      if (effectiveType === 'function_call_output' || effectiveType === 'custom_tool_call_output') {
        pendingReasoning.length = 0;
        const callId = String(item['call_id'] ?? '');
        const toolInfo = findToolById(messages, callId);
        messages.push({
          role: 'toolResult',
          toolCallId: callId,
          toolName: toolInfo.name,
          toolNamespace: toolInfo.namespace,
          content: outputToToolResultContent(item['output'] as string | unknown[] | undefined),
          isError: false,
          timestamp: now,
        });
        continue;
      }
    }
  }

  const declaredTools = buildTools(data['tools'] as unknown[] | undefined);
  const loadedTools = buildTools(loadedToolSpecs);
  const seenTools = new Set<string>();
  const mergedTools = [...declaredTools, ...loadedTools].filter((t) => {
    const k = t.namespace ? `${t.namespace}__${t.name}` : t.name;
    if (seenTools.has(k)) return false;
    seenTools.add(k);
    return true;
  });

  const options: CodexRequestOptions = {};
  if (data['max_output_tokens'] !== undefined) options.maxOutputTokens = data['max_output_tokens'] as number;
  if (data['temperature'] !== undefined) options.temperature = data['temperature'] as number;
  if (data['top_p'] !== undefined) options.topP = data['top_p'] as number;
  const reasoning = isObj(data['reasoning']) ? data['reasoning'] : {};
  // codex-rs converts "ultra" to "max" at the inference boundary.
  const requestedEffort = reasoning['effort'] === 'ultra' ? 'max' : reasoning['effort'];
  if (typeof requestedEffort === 'string' && REASONING_EFFORTS.has(requestedEffort)) {
    options.reasoning = requestedEffort;
  }
  const summaryMode = reasoning['summary'];
  if (!summaryMode || summaryMode === 'none') options.hideThinkingSummary = true;
  const text = isObj(data['text']) ? data['text'] : {};
  if (text['verbosity'] === 'low' || text['verbosity'] === 'medium' || text['verbosity'] === 'high') {
    options.verbosity = text['verbosity'];
  }
  const format = isObj(text['format']) ? text['format'] : undefined;
  if (
    format &&
    format['type'] === 'json_schema' &&
    typeof format['name'] === 'string' &&
    format['name'].length > 0 &&
    format['schema'] !== undefined
  ) {
    options.outputFormat = {
      type: 'json_schema',
      name: format['name'],
      strict: format['strict'] === true,
      schema: structuredClone(format['schema']),
    };
  }

  return {
    modelId,
    context: {
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      messages,
      ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
    },
    stream: data['stream'] === true,
    options,
    _rawBody: body,
    ...(compactionRequest ? { _compactionRequest: true } : {}),
  };
}

export { isOnePixelPngDataUrl };
