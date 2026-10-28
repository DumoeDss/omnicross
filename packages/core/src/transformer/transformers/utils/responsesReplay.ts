type Item = Record<string, unknown>;

function isRecord(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Plaintext reasoning produced by a Chat adapter is not a replayable Responses
 * item. A stateless native upstream tries to resolve its synthetic id and 404s.
 * Call only for stateless native requests; reduced Chat routes need the summary
 * for reasoning_content, and stored Responses requests may legitimately use ids.
 */
export function stripUnencryptedResponsesReasoning(body: Item): Item {
  if (!Array.isArray(body.input)) return body;
  const input = body.input.filter((item) => !isRecord(item) || item.type !== 'reasoning' ||
    (typeof item.encrypted_content === 'string' && item.encrypted_content.trim().length > 0));
  if (input.length !== body.input.length) body.input = input;
  return body;
}

const CODEX_ID_PREFIX: Record<string, string> = {
  reasoning: 'rs_', message: 'msg_', function_call: 'fc_', custom_tool_call: 'ctc_',
};

/** Prefix legacy ids deterministically without mutating the client's items. */
export function normalizeCodexItemIds(body: Item): Item {
  if (!Array.isArray(body.input)) return body;
  body.input = body.input.map((item) => {
    if (!isRecord(item) || typeof item.type !== 'string') return item;
    const prefix = Object.hasOwn(CODEX_ID_PREFIX, item.type) ? CODEX_ID_PREFIX[item.type] : undefined;
    const id = item.id;
    return prefix && typeof id === 'string' && id !== '' && !id.startsWith(prefix)
      ? { ...item, id: `${prefix}${id}` } : item;
  });
  return body;
}

/** The Codex subscription always uses stateless replay, even if store is absent. */
export function sanitizeCodexResponsesRequest(body: Item): Item {
  return normalizeCodexItemIds(stripUnencryptedResponsesReasoning(body));
}
