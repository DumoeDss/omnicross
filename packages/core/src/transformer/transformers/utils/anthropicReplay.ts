type Item = Record<string, unknown>;
type Target = { name?: string; baseUrl?: string };

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isClaudeTarget(model: unknown, target?: Target): boolean {
  if (typeof model === 'string' && /^(?:anthropic[/.]|claude(?:$|[-_.]))/i.test(model)) return true;
  if (target?.name === 'claude') return true;
  try {
    const host = new URL(target?.baseUrl ?? '').hostname;
    return host === 'anthropic.com' || host.endsWith('.anthropic.com');
  } catch { return false; }
}

/**
 * Chat/Gemini adapters expose foreign reasoning as unsigned thinking to Claude
 * Code. It remains useful on the original provider, but is not authenticated
 * Claude thinking and cannot be replayed to Claude. Repair only the outgoing
 * Claude request, including same-format relays; signed/redacted native blocks,
 * tool ids/results and third-party Anthropic-compatible traffic are preserved.
 */
export function sanitizeAnthropicReplay(body: Item, target?: Target): Item {
  if (!isClaudeTarget(body.model, target) || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages: unknown[] = [];
  for (const raw of body.messages) {
    if (!isRecord(raw) || raw.role !== 'assistant' || !Array.isArray(raw.content)) {
      messages.push(raw);
      continue;
    }
    const content = raw.content.filter((block) => !isRecord(block) || block.type !== 'thinking' || nonEmpty(block.signature));
    if (content.length === raw.content.length) messages.push(raw);
    else {
      changed = true;
      if (content.length > 0) messages.push({ ...raw, content });
    }
  }

  // Legacy manual thinking requires a signed thinking block at the start of
  // the final assistant tool turn. A foreign tool call has none. Complete that
  // tool loop without manual thinking; the next request can enable it again.
  // Adaptive thinking has no such structural requirement and stays enabled.
  let thinking = body.thinking;
  if (isRecord(thinking) && thinking.type === 'enabled') {
    let lastAssistant = messages.length - 1;
    while (lastAssistant >= 0) {
      const message = messages[lastAssistant];
      if (isRecord(message) && message.role === 'assistant') break;
      lastAssistant--;
    }
    const assistant = messages[lastAssistant];
    if (isRecord(assistant) && Array.isArray(assistant.content)) {
      const first = assistant.content[0];
      const hasThinking = isRecord(first) &&
        ((first.type === 'thinking' && nonEmpty(first.signature)) || first.type === 'redacted_thinking');
      const hasToolCall = assistant.content.some((block) => isRecord(block) && block.type === 'tool_use');
      const trailing = messages.slice(lastAssistant + 1);
      const hasToolResult = trailing.length > 0 && trailing.every((message) =>
        isRecord(message) && Array.isArray(message.content) &&
        message.content.some((block) => isRecord(block) && block.type === 'tool_result'));
      if (!hasThinking && hasToolCall && hasToolResult) {
        thinking = { type: 'disabled' };
        changed = true;
      }
    }
  }
  return changed ? { ...body, messages, ...(thinking !== body.thinking ? { thinking } : {}) } : body;
}

/** Preserve original bytes on a valid same-format request. */
export function sanitizeAnthropicReplayBody(rawBody: string, target?: Target): string {
  const body = JSON.parse(rawBody) as Item;
  const sanitized = sanitizeAnthropicReplay(body, target);
  return sanitized === body ? rawBody : JSON.stringify(sanitized);
}
