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
    return { reasoningSummary: declaration.providerApiFormat === 'openai-response' };
  }

  const transformerNames = declaration.subscriptionTransformerNames ?? [];
  return {
    // An empty subscription chain falls back to OpenAIResponseTransformer in
    // resolveSubscriptionChain, so it has the same summary fidelity.
    reasoningSummary:
      transformerNames.length === 0 || transformerNames.includes('openai-response'),
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

const TOP_LEVEL_FIELDS = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'max_output_tokens',
  'temperature',
  'reasoning',
  'tools',
]);

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);
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

/** Validate the exact subset the declared reduced target preserves. */
export function validateReducedResponsesRequest(
  body: unknown,
  capabilities: ReducedResponsesCapabilities,
): asserts body is Record<string, unknown> {
  if (!isRecord(body)) fail('$', 'must be a JSON object');
  assertOnlyFields(body, TOP_LEVEL_FIELDS, '$');

  if (body.model !== undefined) assertString(body.model, '$.model');
  if (body.instructions !== undefined) assertString(body.instructions, '$.instructions');
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

  if (body.reasoning !== undefined) {
    if (!isRecord(body.reasoning)) fail('$.reasoning', 'must be an object');
    assertOnlyFields(body.reasoning, new Set(['effort', 'summary']), '$.reasoning');
    if (typeof body.reasoning.effort !== 'string' || !REASONING_EFFORTS.has(body.reasoning.effort)) {
      fail('$.reasoning.effort', 'is not supported');
    }
    if (
      body.reasoning.summary !== undefined &&
      (typeof body.reasoning.summary !== 'string' || !REASONING_SUMMARIES.has(body.reasoning.summary))
    ) {
      fail('$.reasoning.summary', 'is not supported');
    }
    if (body.reasoning.summary !== undefined && !capabilities.reasoningSummary) {
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
}
