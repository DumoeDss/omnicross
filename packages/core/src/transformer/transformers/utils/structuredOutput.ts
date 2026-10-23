/**
 * Structured-output fallback for chat wires that only support `json_object`.
 *
 * A Responses client expresses structured output as `text.format`
 * (`{type:'json_schema', name, strict, schema}`), which the reduced chain maps
 * onto the chat wire's `response_format`. Official OpenAI and most aggregators
 * accept `response_format.type = 'json_schema'`, but some OpenAI-compatible
 * upstreams support ONLY `json_object`:
 *
 *   DeepSeek (v4-flash and v4-pro, 2026-10-20):
 *     400 "This response_format type is unavailable now"
 *
 * That 400 kills the whole request — codex's `exec --output-schema`, the TUI
 * recap (a temporary structured thread), and guardian review all send one, so
 * routing codex to such a provider silently breaks structured features and
 * hard-fails `--output-schema`.
 *
 * The fallback keeps the contract as close as the wire allows: `json_object`
 * still guarantees a JSON reply, and the schema is folded into a system
 * instruction so the model knows the expected shape. Server-side strict
 * validation is unavailable there, so a malformed reply is possible — the
 * caller's own schema check decides, exactly as a strict-mode violation would.
 *
 * Two entry points share this module:
 *  - {@link downgradeJsonSchemaBody} — pure body rewrite (chat wire), used by
 *    the chat encoder for KNOWN json_object-only providers and by the runtime
 *    fallback after a rejection.
 *  - {@link isResponseFormatRejection} + the unsupported-key registry — the
 *    Responses driver learns from a 400 once per provider+model and rewrites
 *    proactively afterwards, so an unknown upstream pays the failed round trip
 *    at most once.
 *
 * @module transformer/transformers/utils/structuredOutput
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Providers whose chat wire rejects `response_format.type = 'json_schema'`.
 *
 * Detection is by provider IDENTITY (name or base URL reads DeepSeek), not by
 * model name: an aggregator that merely hosts a `deepseek-*` model may support
 * strict schemas, and downgrading it would throw away validation it can honor.
 * The runtime fallback (see the Responses driver) covers everything else.
 */
export function isJsonObjectOnlyProvider(
  provider: { name?: string; baseUrl?: string } | undefined,
): boolean {
  if (!provider) return false;
  return /deepseek/i.test(provider.name ?? '') || /deepseek/i.test(provider.baseUrl ?? '');
}

/** One downgrade instruction for a schema, or the bare JSON directive. */
function buildSchemaInstruction(schema: unknown, name: string | undefined): string {
  const header =
    'Respond with a single JSON value only — no prose, no markdown fences.';
  if (schema === undefined) return header;
  return (
    `${header} It must conform to this JSON Schema` +
    `${name ? ` (${name})` : ''}:\n${JSON.stringify(schema)}`
  );
}

/**
 * Rewrite a chat-wire body from `json_schema` to `json_object`, folding the
 * schema into a prepended system instruction. Idempotent: a body already in
 * json_object mode (or carrying no structured-output contract) is untouched.
 *
 * @returns true when the body actually changed.
 */
export function downgradeJsonSchemaBody(body: JsonRecord): boolean {
  const format = body.response_format;
  if (!isRecord(format) || format.type !== 'json_schema') return false;

  const schemaBox = isRecord(format.json_schema) ? format.json_schema : undefined;
  body.response_format = { type: 'json_object' };

  const instruction = buildSchemaInstruction(
    schemaBox?.schema,
    typeof schemaBox?.name === 'string' ? schemaBox.name : undefined,
  );
  if (Array.isArray(body.messages)) {
    body.messages.unshift({ role: 'system', content: instruction });
  } else if (typeof body.instructions === 'string') {
    body.instructions = `${instruction}\n\n${body.instructions}`;
  }
  return true;
}

/**
 * Whether an upstream status+body is a rejection of the structured-output
 * contract specifically. Deliberately narrow: a 400 that merely mentions
 * "invalid" must not trigger a rewrite-and-retry of an unrelated failure.
 */
export function isResponseFormatRejection(status: number, errorText: string): boolean {
  if (status !== 400 || typeof errorText !== 'string' || !errorText) return false;
  if (!/response[ _-]?format|json_schema/i.test(errorText)) return false;
  return /unavailable|unsupported|not\s+support|unrecognized|unknown/i.test(errorText)
    || /invalid\s+(?:response[ _-]?format\s+)?type/i.test(errorText);
}

/**
 * providerIdentity+model keys already observed rejecting json_schema. Process-
 * local on purpose: it is a routing optimization, not persistence — a daemon
 * restart simply pays one failed round trip again.
 */
const unsupportedKeys = new Set<string>();

export function markJsonSchemaUnsupported(key: string): void {
  if (key) unsupportedKeys.add(key);
}

export function isJsonSchemaUnsupported(key: string): boolean {
  return unsupportedKeys.has(key);
}

/** TEST SEAM — clear the learned registry between suites. */
export function resetStructuredOutputStateForTests(): void {
  unsupportedKeys.clear();
}
