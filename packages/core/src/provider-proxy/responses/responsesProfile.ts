import type { ApiFormat } from '@omnicross/contracts/llm-config';

import { OpenAIOperationError } from '../../openai-operation';

export type ResponsesProfile = 'native' | 'reduced';

export interface ResponsesProfileDeclaration {
  readonly authMode: 'byo' | 'subscription';
  readonly providerApiFormat?: ApiFormat;
  readonly subscriptionProviderId?: string;
  readonly subscriptionTransformerNames?: readonly string[];
  readonly upstreamUrl?: string;
}

export interface ReducedResponsesCapabilities {
  /** Whether the target wire can preserve `reasoning.summary`. */
  readonly reasoningSummary: boolean;
  /**
   * Whether the target wire has a structured-output counterpart for the
   * Responses `text.format` (chat `response_format`, Gemini
   * `responseMimeType`/`responseSchema`). Anthropic-shaped wires have none —
   * a structured-output contract there must fail loudly, not answer free text.
   */
  readonly textFormat: boolean;
}

/**
 * Resolve the protocol contract from explicit provider metadata. Transformer
 * instance identity and transformer-array equality are deliberately irrelevant.
 */
export function classifyResponsesProfile(
  declaration: ResponsesProfileDeclaration,
): ResponsesProfile {
  if (declaration.authMode === 'byo') {
    return declaration.providerApiFormat === 'openai-response' ? 'native' : 'reduced';
  }

  if (
    declaration.subscriptionProviderId === 'codex' &&
    declaration.subscriptionTransformerNames?.includes('openai-response') &&
    isResponsesCreateUrl(declaration.upstreamUrl)
  ) {
    return 'native';
  }
  return 'reduced';
}

/**
 * Resolve reduced-profile fidelity from the same declarative route metadata
 * used for classification. This must stay independent of transformer-service
 * resolution so unsupported requests fail before auth or transformer lookup.
 */
export function resolveReducedResponsesCapabilities(
  declaration: ResponsesProfileDeclaration,
): ReducedResponsesCapabilities {
  if (declaration.authMode === 'byo') {
    return {
      reasoningSummary: declaration.providerApiFormat === 'openai-response',
      textFormat: declaration.providerApiFormat !== 'anthropic',
    };
  }

  const transformerNames = declaration.subscriptionTransformerNames ?? [];
  return {
    // An empty subscription chain falls back to OpenAIResponseTransformer in
    // resolveSubscriptionChain, so it has the same summary fidelity.
    reasoningSummary:
      transformerNames.length === 0 || transformerNames.includes('openai-response'),
    textFormat: !transformerNames.includes('anthropic'),
  };
}

function isResponsesCreateUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).pathname.replace(/\/+$/, '').endsWith('/responses');
  } catch {
    return false;
  }
}

// ── Reduced-profile admission policy (three tiers) ─────────────────────────
//
// The codex CLI (and any Responses-native client) evolves its request surface
// every few months. A strict unknown-field 400 turns each such update into
// client downtime, so top-level fields are tiered instead:
//
//   1. KNOWN (TOP_LEVEL_FIELDS) — validated, then mapped where representable
//      or audited-dropped where they are session hints. `tool_choice` /
//      `parallel_tool_calls` / `top_p` are representable on every reduced
//      target (chat native; Anthropic maps them; Gemini maps tool_choice+top_p
//      and drops parallel_tool_calls). `store:false`, `include`,
//      `truncation`, `prompt_cache_key`, `text.verbosity` are codex's
//      stateless-session contract — no reduced-wire meaning, and none is a
//      server-state REFERENCE, so they are dropped at the transform boundary
//      with a dropped_field audit (field NAMES only). `text.format` splits
//      from its sibling: it is the structured-output CONTRACT — mapped onto
//      wires with a counterpart (chat `response_format`, Gemini
//      `responseSchema`) and REFUSED on wires without one (Anthropic-shaped),
//      because silently answering free text where the caller parses JSON
//      corrupts the caller.
//   2. DENIED (DENIED_TOP_LEVEL_FIELDS) — serving these SILENTLY WRONG is the
//      risk, not lost fidelity: `previous_response_id` references server-side
//      state on the ORIGINAL provider; `background:true` switches the
//      response protocol to async job semantics. These fail loudly.
//   3. UNKNOWN — admitted and audit-dropped. The transform layers below are
//      field-by-field builders, so an unknown field physically cannot reach
//      the upstream; the gate's job is to report it (the returned names feed
//      the dropped_field counter), not to break the client over a knob it
//      will never see honored.
//
// Nested shapes stay STRICT: an unknown input-item / content-part / tool /
// tool_choice type can carry conversation content, and dropping one silently
// corrupts the history — that must stay a loud, structured 400. The ONE
// nested exception is `reasoning`, a knob container: its unknown sub-fields
// (e.g. codex's `reasoning.context`) are treated like unknown top-level
// knobs — admitted, audit-dropped, reported by name.
const TOP_LEVEL_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'prompt',
  'stream',
  'max_output_tokens',
  'temperature',
  'top_p',
  'reasoning',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'store',
  'include',
  'prompt_cache_key',
  'truncation',
  'text',
]);

const DENIED_TOP_LEVEL_FIELDS = new Set(['previous_response_id', 'background']);

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);
const TOOL_CHOICE_MODES = new Set(['auto', 'none', 'required']);
const TOOL_CHOICE_ALLOWED_MODES = new Set(['auto', 'required']);
const TRUNCATION_VALUES = new Set(['auto', 'none']);
const TEXT_FORMAT_TYPES = new Set(['text', 'json_object', 'json_schema']);
const MESSAGE_ROLES = new Set(['developer', 'system', 'user', 'assistant']);
const TEXT_PART_TYPES = new Set(['text', 'input_text', 'output_text', 'summary_text']);

export function unsupportedResponsesCapability(
  path: string,
  detail = 'cannot be represented by the reduced Responses profile',
): OpenAIOperationError {
  return new OpenAIOperationError({
    status: 400,
    code: 'unsupported_capability',
    message: `${path} ${detail}`,
  });
}

function fail(path: string, detail?: string): never {
  throw unsupportedResponsesCapability(path, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(`${path}.${field}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(path, 'must be a string');
}

function validateTextPart(value: unknown, path: string): void {
  if (!isRecord(value)) fail(path, 'must be a text content part');
  const type = value.type;
  if (typeof type !== 'string' || !TEXT_PART_TYPES.has(type)) {
    fail(`${path}.type`, 'is not a supported text content part');
  }
  assertOnlyFields(value, new Set(['type', 'text']), path);
  assertString(value.text, `${path}.text`);
}

function validateTextContent(value: unknown, path: string): void {
  if (typeof value === 'string') return;
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be text or a non-empty array of text parts');
  }
  value.forEach((part, index) => validateTextPart(part, `${path}[${index}]`));
}

const MESSAGE_FIELDS = new Set(['type', 'role', 'content']);
const CALL_FIELDS = new Set(['type', 'call_id', 'name', 'namespace', 'arguments']);
const CUSTOM_CALL_FIELDS = new Set(['type', 'call_id', 'name', 'input']);
const OUTPUT_FIELDS = new Set(['type', 'call_id', 'output']);
const ADDITIONAL_TOOLS_FIELDS = new Set(['type', 'role', 'tools']);

function validateToolDeclaration(
  value: unknown,
  path: string,
  allowNamespace = false,
): void {
  if (!isRecord(value)) fail(path, 'must be a tool declaration object');
  const type = value.type;
  if (type === 'function') {
    assertOnlyFields(value, new Set(['type', 'name', 'description', 'parameters']), path);
    assertString(value.name, `${path}.name`);
    if (value.description !== undefined) assertString(value.description, `${path}.description`);
    if (value.parameters !== undefined && !isRecord(value.parameters)) {
      fail(`${path}.parameters`, 'must be an object');
    }
    return;
  }
  if (type === 'custom') {
    assertOnlyFields(value, new Set(['type', 'name', 'description']), path);
    assertString(value.name, `${path}.name`);
    if (value.description !== undefined) assertString(value.description, `${path}.description`);
    return;
  }
  if (type === 'namespace' && allowNamespace) {
    assertOnlyFields(value, new Set(['type', 'name', 'description', 'tools']), path);
    assertString(value.name, `${path}.name`);
    if (value.description !== undefined) assertString(value.description, `${path}.description`);
    if (!Array.isArray(value.tools)) fail(`${path}.tools`, 'must be an array');
    value.tools.forEach((tool, index) =>
      validateToolDeclaration(tool, `${path}.tools[${index}]`, true));
    return;
  }
  fail(`${path}.type`, 'is a hosted or unsupported tool type');
}

function validateToolChoice(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (!TOOL_CHOICE_MODES.has(value)) {
      fail(path, 'must be "auto", "none", "required", a function choice, or an allowed_tools choice');
    }
    return;
  }
  if (!isRecord(value)) fail(path, 'must be a tool choice');
  if (value.type === 'function') {
    assertOnlyFields(value, new Set(['type', 'name']), path);
    assertString(value.name, `${path}.name`);
    return;
  }
  if (value.type === 'allowed_tools') {
    assertOnlyFields(value, new Set(['type', 'mode', 'tools']), path);
    if (typeof value.mode !== 'string' || !TOOL_CHOICE_ALLOWED_MODES.has(value.mode)) {
      fail(`${path}.mode`, 'must be "auto" or "required"');
    }
    if (!Array.isArray(value.tools) || value.tools.length === 0) {
      fail(`${path}.tools`, 'must be a non-empty array');
    }
    value.tools.forEach((tool, index) => {
      const toolPath = `${path}.tools[${index}]`;
      if (!isRecord(tool) || tool.type !== 'function') {
        fail(`${toolPath}.type`, 'must be a function tool choice');
      }
      assertOnlyFields(tool, new Set(['type', 'name']), toolPath);
      assertString(tool.name, `${toolPath}.name`);
    });
    return;
  }
  fail(`${path}.type`, 'is a hosted or unsupported tool choice');
}

function validateInputItem(value: unknown, path: string): void {
  if (!isRecord(value)) fail(path, 'must be a supported input item');
  const type = typeof value.type === 'string' ? value.type : undefined;

  if (type === undefined || type === 'message') {
    assertOnlyFields(value, MESSAGE_FIELDS, path);
    if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role)) {
      fail(`${path}.role`, 'is not a supported message role');
    }
    validateTextContent(value.content, `${path}.content`);
    return;
  }
  if (type === 'function_call') {
    assertOnlyFields(value, CALL_FIELDS, path);
    assertString(value.call_id, `${path}.call_id`);
    assertString(value.name, `${path}.name`);
    if (value.namespace !== undefined) assertString(value.namespace, `${path}.namespace`);
    assertString(value.arguments, `${path}.arguments`);
    return;
  }
  if (type === 'custom_tool_call') {
    assertOnlyFields(value, CUSTOM_CALL_FIELDS, path);
    assertString(value.call_id, `${path}.call_id`);
    assertString(value.name, `${path}.name`);
    assertString(value.input, `${path}.input`);
    return;
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    assertOnlyFields(value, OUTPUT_FIELDS, path);
    assertString(value.call_id, `${path}.call_id`);
    validateTextContent(value.output, `${path}.output`);
    return;
  }
  if (type === 'additional_tools') {
    assertOnlyFields(value, ADDITIONAL_TOOLS_FIELDS, path);
    if (!Array.isArray(value.tools)) fail(`${path}.tools`, 'must be an array');
    value.tools.forEach((tool, index) =>
      validateToolDeclaration(tool, `${path}.tools[${index}]`, true));
    return;
  }
  fail(`${path}.type`, 'is an opaque or unsupported input item type');
}

/**
 * Validate a reduced-profile Responses request. Known fields are shape-checked
 * (a violation fails with `unsupported_capability`); DENIED fields fail; any
 * OTHER top-level field is admitted and its NAME returned so the caller can
 * feed the dropped_field audit — the field itself evaporates at the transform
 * boundary below. Nested shapes stay strict for the same reason as DENIED:
 * silently dropping them corrupts semantics instead of just a knob.
 */
export function validateReducedResponsesRequest(
  body: unknown,
  capabilities: ReducedResponsesCapabilities,
): string[] {
  if (!isRecord(body)) fail('$', 'must be a JSON object');
  const unknownFields: string[] = [];
  for (const field of Object.keys(body)) {
    if (DENIED_TOP_LEVEL_FIELDS.has(field)) fail(`$.${field}`);
    if (!TOP_LEVEL_FIELDS.has(field)) unknownFields.push(field);
  }

  if (body.model !== undefined) assertString(body.model, '$.model');
  if (body.instructions !== undefined) assertString(body.instructions, '$.instructions');
  // Newer Responses clients may send `prompt` instead of `instructions`.
  if (body.prompt !== undefined) assertString(body.prompt, '$.prompt');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('$.stream', 'must be a boolean');
  if (
    body.max_output_tokens !== undefined &&
    (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) <= 0)
  ) {
    fail('$.max_output_tokens', 'must be a positive integer');
  }
  if (body.temperature !== undefined && typeof body.temperature !== 'number') {
    fail('$.temperature', 'must be a number');
  }
  if (body.top_p !== undefined && typeof body.top_p !== 'number') {
    fail('$.top_p', 'must be a number');
  }

  if (body.reasoning !== undefined) {
    if (!isRecord(body.reasoning)) fail('$.reasoning', 'must be an object');
    // `reasoning` is a KNOB container (effort / summary / context / …), not
    // conversation content: an unknown sub-field (codex added
    // `reasoning.context` in the wild) is an ignored knob, so it joins the
    // audit-dropped list instead of 400-ing. Structural containers (input
    // items, tools, tool_choice, text) stay strict — see the policy note
    // above.
    for (const field of Object.keys(body.reasoning)) {
      if (field !== 'effort' && field !== 'summary') unknownFields.push(`reasoning.${field}`);
    }
    if (typeof body.reasoning.effort !== 'string' || !REASONING_EFFORTS.has(body.reasoning.effort)) {
      fail('$.reasoning.effort', 'is not supported');
    }
    if (
      body.reasoning.summary !== undefined &&
      (typeof body.reasoning.summary !== 'string' || !REASONING_SUMMARIES.has(body.reasoning.summary))
    ) {
      fail('$.reasoning.summary', 'is not supported');
    }
    // `summary:'auto'` is best-effort ("include summaries if the model
    // produces them") — codex sends it on every reasoning-model turn and must
    // tolerate a target that produces none, so it passes for every target. An
    // explicit 'concise'/'detailed' level is a fidelity demand only
    // summary-preserving targets accept.
    if (
      body.reasoning.summary !== undefined &&
      body.reasoning.summary !== 'auto' &&
      !capabilities.reasoningSummary
    ) {
      fail('$.reasoning.summary');
    }
  }

  if (body.input !== undefined) {
    if (typeof body.input !== 'string') {
      if (!Array.isArray(body.input)) fail('$.input', 'must be text or an array');
      body.input.forEach((item, index) => validateInputItem(item, `$.input[${index}]`));
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) fail('$.tools', 'must be an array');
    body.tools.forEach((tool, index) => validateToolDeclaration(tool, `$.tools[${index}]`));
  }
  if (body.tool_choice !== undefined) validateToolChoice(body.tool_choice, '$.tool_choice');

  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    fail('$.parallel_tool_calls', 'must be a boolean');
  }
  // Only `store:false` (the codex stateless-mode constant) is admissible —
  // `store:true` asks for server-side response storage, which is exactly the
  // native-Responses state the reduced relay replaces with stateless replay.
  if (body.store !== undefined && body.store !== false) {
    fail('$.store', 'requires a native Responses provider (the reduced relay is stateless)');
  }
  if (body.include !== undefined) {
    if (!Array.isArray(body.include) || body.include.some((item) => typeof item !== 'string')) {
      fail('$.include', 'must be an array of strings');
    }
  }
  if (body.prompt_cache_key !== undefined) assertString(body.prompt_cache_key, '$.prompt_cache_key');
  if (body.truncation !== undefined) {
    if (typeof body.truncation !== 'string' || !TRUNCATION_VALUES.has(body.truncation)) {
      fail('$.truncation', 'must be "auto" or "none"');
    }
  }
  if (body.text !== undefined) {
    if (!isRecord(body.text)) fail('$.text', 'must be an object');
    assertOnlyFields(body.text, new Set(['verbosity', 'format']), '$.text');
    if (body.text.verbosity !== undefined) assertString(body.text.verbosity, '$.text.verbosity');
    if (body.text.format !== undefined) {
      const format = body.text.format;
      if (!isRecord(format)) fail('$.text.format', 'must be an object');
      assertOnlyFields(format, new Set(['type', 'name', 'strict', 'schema']), '$.text.format');
      if (typeof format.type !== 'string' || !TEXT_FORMAT_TYPES.has(format.type)) {
        fail('$.text.format.type', 'must be "text", "json_object", or "json_schema"');
      }
      // A structured-output contract is SEMANTICS, not a knob: on wires with
      // no counterpart (Anthropic-shaped) the request must fail loudly —
      // silently answering free text where the caller parses JSON corrupts
      // the caller. The plain "text" format is a no-op anywhere.
      if (format.type !== 'text' && !capabilities.textFormat) {
        fail('$.text.format.type', 'requires a target wire with structured-output support');
      }
      if (format.type === 'json_schema' && !isRecord(format.schema)) {
        fail('$.text.format.schema', 'must be an object');
      }
    }
  }
  return unknownFields;
}
