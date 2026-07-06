/**
 * userMessageDetection — decide whether a parsed outbound request body is a
 * REAL user-message turn (serialize it) vs a tool-loop continuation (bypass the
 * serial queue) (queue/concurrency, design D-CORE-4).
 *
 * The serial queue protects a shared upstream account from looking like many
 * concurrent humans. Only human-INITIATED turns should be serialized; a
 * tool-loop turn (the client feeding a tool result back) must NOT be throttled
 * or it stalls the agent. This module classifies the LAST turn per ingress
 * format, aligned to claude-relay-service's `isUserMessageRequest` semantics but
 * covering all four omnicross ingress formats.
 *
 * SAFETY BIAS: default `false` (bypass) on any shape it cannot POSITIVELY
 * classify as a human turn. Under-serializing only costs the (opt-in, default-
 * off) protection; over-serializing would stall real tool-loops.
 *
 * @module outbound-api/userMessageDetection
 */

import type { OutboundEndpoint } from './types';

/** A JSON object (the parsed request body). */
type Body = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asObject(v: unknown): Body | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : null;
}

/** The last element of an array, or `undefined`. */
function last(arr: unknown[]): unknown {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/**
 * Anthropic `messages`: the last `messages` entry is `role:'user'` AND its
 * content carries no `tool_result` block (a `tool_result` block is the client
 * feeding a tool response back — a tool-loop turn, not a human turn).
 */
function isUserMessageAnthropic(body: Body): boolean {
  const messages = asArray(body['messages']);
  const lastMsg = asObject(last(messages));
  if (!lastMsg || lastMsg['role'] !== 'user') return false;
  const content = lastMsg['content'];
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      (block) => asObject(block)?.['type'] === 'tool_result',
    );
    return !hasToolResult;
  }
  return false;
}

/**
 * OpenAI `responses`: `input` is either a plain string (a human turn) or an
 * array of items whose LAST item is a `role:'user'` message. A trailing
 * `function_call_output` item is a tool result → bypass.
 */
function isUserMessageResponses(body: Body): boolean {
  const input = body['input'];
  if (typeof input === 'string') return input.length > 0;
  if (Array.isArray(input)) {
    const lastItem = asObject(last(input));
    if (!lastItem) return false;
    if (lastItem['type'] === 'function_call_output') return false;
    return lastItem['role'] === 'user';
  }
  return false;
}

/**
 * OpenAI `chat`: the last `messages` entry is `role:'user'`. A trailing
 * `role:'tool'` entry is a tool result → bypass.
 */
function isUserMessageChat(body: Body): boolean {
  const messages = asArray(body['messages']);
  const lastMsg = asObject(last(messages));
  if (!lastMsg) return false;
  return lastMsg['role'] === 'user';
}

/**
 * Gemini `generateContent`: the last `contents` entry is `role:'user'` AND has
 * no `functionResponse` part (a `functionResponse` part is a tool result →
 * bypass). Gemini also uses `role:'user'` to carry function responses, so the
 * part check — not just the role — is what distinguishes a human turn.
 */
function isUserMessageGemini(body: Body): boolean {
  const contents = asArray(body['contents']);
  const lastContent = asObject(last(contents));
  if (!lastContent || lastContent['role'] !== 'user') return false;
  const parts = asArray(lastContent['parts']);
  const hasFunctionResponse = parts.some(
    (part) => asObject(part)?.['functionResponse'] !== undefined,
  );
  return !hasFunctionResponse;
}

/**
 * Decide whether `parsedBody` for `endpoint` is a real user-message turn (→
 * serialize) vs a tool-loop / non-user turn (→ bypass). Defaults `false` on any
 * unclassifiable shape.
 */
export function isUserMessageRequest(endpoint: OutboundEndpoint, parsedBody: unknown): boolean {
  const body = asObject(parsedBody);
  if (!body) return false;
  switch (endpoint) {
    case 'messages':
      return isUserMessageAnthropic(body);
    case 'responses':
      return isUserMessageResponses(body);
    case 'chat':
      return isUserMessageChat(body);
    case 'gemini':
      return isUserMessageGemini(body);
    default:
      return false;
  }
}
