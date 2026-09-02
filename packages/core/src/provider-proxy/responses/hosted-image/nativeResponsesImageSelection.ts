import { randomUUID } from 'node:crypto';

import type {
  ResponsesHostedToolIdentity,
  ResponsesHostedToolSelection,
  ResponsesImageAdmission,
  ResponsesSelectedImageCall,
} from '../../../image-generation/responses/types';
import { ImageGenerationError } from '../../../image-generation/errors';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface NativeResponsesSelectedImageCall {
  readonly call: ResponsesSelectedImageCall;
  readonly presentationIndex: number;
  readonly upstreamCallId: string;
  readonly itemIndex: number;
}

export interface NativeResponsesImageSelectionResult {
  readonly selection: ResponsesHostedToolSelection;
  readonly imageCalls: readonly NativeResponsesSelectedImageCall[];
  readonly internalItemIds: readonly string[];
}

export interface NativeResponsesImageSelectionPreparation {
  readonly upstreamBody: Record<string, unknown>;
  readonly selectorName?: string;
  parseOutput(output: unknown): NativeResponsesImageSelectionResult;
}

export interface PrepareNativeResponsesImageSelectionInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly admission: ResponsesImageAdmission;
  readonly pendingReceipts?: readonly NativeResponsesPendingImageReceipt[];
  readonly createSelectorName?: () => string;
}

export interface NativeResponsesPendingImageReceipt {
  readonly upstreamCallId: string;
  readonly publicImageCallId: string;
}

const SELECTOR_DESCRIPTION = 'Select image generation or editing and provide its image prompt.';
const SELECTOR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const WIRE_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/;
const UPSTREAM_CALL_ID_PATTERN = /^call_[A-Za-z0-9_-]{1,240}$/;
const PUBLIC_IMAGE_CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const MAX_SELECTOR_NAME_ATTEMPTS = 16;
const MAX_PENDING_RECEIPTS = 16;
const SELECTOR_ITEM_KEYS = new Set([
  'id', 'type', 'status', 'call_id', 'name', 'arguments',
]);
/**
 * Which declaration types can produce which hosted output-item type.
 *
 * Exported because the hosted-SEARCH lane needs the same
 * `web_search_call -> ['web_search_preview', 'web_search']` row (wire baseline
 * R6): one table, so the two lanes cannot disagree about what a hosted search
 * declaration looks like.
 */
export const HOSTED_CALL_DECLARATION_TYPES: Readonly<Record<string, readonly string[]>> = {
  web_search_call: ['web_search_preview', 'web_search'],
  file_search_call: ['file_search'],
  computer_call: ['computer_use_preview', 'computer_use'],
  code_interpreter_call: ['code_interpreter'],
  local_shell_call: ['local_shell'],
  shell_call: ['shell'],
  apply_patch_call: ['apply_patch'],
  mcp_call: ['mcp'],
};

function cloneInputWithoutLocalImageCalls(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input
    .filter((item) => !isRecord(item) || item.type !== 'image_generation_call')
    .map((item) => isRecord(item) ? { ...item } : item);
}

function inputItemsForReceiptInjection(input: unknown): readonly unknown[] {
  const cloned = cloneInputWithoutLocalImageCalls(input);
  if (Array.isArray(cloned)) return cloned;
  if (typeof cloned === 'string') {
    return [{
      role: 'user',
      content: [{ type: 'input_text', text: cloned }],
    }];
  }
  if (cloned === undefined) return [];
  protocolFailure();
}

function pendingReceiptItems(
  receipts: readonly NativeResponsesPendingImageReceipt[] | undefined,
): readonly Record<string, unknown>[] {
  if (!receipts) return [];
  if (!Array.isArray(receipts) || receipts.length > MAX_PENDING_RECEIPTS) protocolFailure();
  const upstreamIds = new Set<string>();
  const publicIds = new Set<string>();
  return receipts.map((receipt) => {
    const candidate: unknown = receipt;
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some(
        (key) => key !== 'upstreamCallId' && key !== 'publicImageCallId',
      )
    ) {
      protocolFailure();
    }
    const upstreamCallId = candidate.upstreamCallId;
    const publicImageCallId = candidate.publicImageCallId;
    if (
      typeof upstreamCallId !== 'string' ||
      !UPSTREAM_CALL_ID_PATTERN.test(upstreamCallId) ||
      typeof publicImageCallId !== 'string' ||
      !PUBLIC_IMAGE_CALL_ID_PATTERN.test(publicImageCallId) ||
      upstreamIds.has(upstreamCallId) ||
      publicIds.has(publicImageCallId)
    ) {
      protocolFailure();
    }
    upstreamIds.add(upstreamCallId);
    publicIds.add(publicImageCallId);
    return {
      type: 'function_call_output',
      call_id: upstreamCallId,
      output: JSON.stringify({
        status: 'completed',
        image_generation_call_id: publicImageCallId,
      }),
    };
  });
}

function selectorDeclaration(name: string): Record<string, unknown> {
  return {
    type: 'function',
    name,
    description: SELECTOR_DESCRIPTION,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 32_000 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

function createNonCollidingSelectorName(
  tools: readonly unknown[],
  createName: () => string,
): string {
  const declaredNames = new Set(
    tools.flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []),
  );
  for (let attempt = 0; attempt < MAX_SELECTOR_NAME_ATTEMPTS; attempt += 1) {
    let candidate: unknown;
    try {
      candidate = createName();
    } catch {
      throw new ImageGenerationError('image_generation_failed');
    }
    if (
      typeof candidate === 'string' &&
      SELECTOR_NAME_PATTERN.test(candidate) &&
      !declaredNames.has(candidate)
    ) {
      return candidate;
    }
  }
  throw new ImageGenerationError('image_generation_failed');
}

function protocolFailure(): never {
  throw new ImageGenerationError('upstream_protocol_changed');
}

function parseSelectorPrompt(value: unknown): ResponsesSelectedImageCall {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    protocolFailure();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    protocolFailure();
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== 'prompt') ||
    typeof parsed.prompt !== 'string' ||
    !parsed.prompt.trim() ||
    parsed.prompt.length > 32_000
  ) {
    protocolFailure();
  }
  return Object.freeze({ prompt: parsed.prompt });
}

function declaredOtherTool(
  admission: ResponsesImageAdmission,
  item: Record<string, unknown>,
): ResponsesHostedToolIdentity | undefined {
  if (typeof item.type !== 'string') return undefined;
  const types = item.type === 'function_call'
    ? ['function']
    : item.type === 'custom_tool_call'
      ? ['custom']
      : HOSTED_CALL_DECLARATION_TYPES[item.type] ?? [];
  if (types.length === 0) return undefined;
  const name = typeof item.name === 'string' ? item.name : undefined;
  const matches = admission.otherTools.filter(
    (identity) => types.includes(identity.type) && (
      item.type === 'function_call' || item.type === 'custom_tool_call'
        ? identity.name === name
        : identity.name === undefined || identity.name === name
    ),
  );
  if (matches.length > 1) protocolFailure();
  return matches[0];
}

function validateToolCallIdentity(
  item: Record<string, unknown>,
  seenItemIds: Set<string>,
  seenCallIds: Set<string>,
): { readonly itemId: string; readonly callId: string } {
  if (
    typeof item.id !== 'string' ||
    !WIRE_ITEM_ID_PATTERN.test(item.id) ||
    typeof item.call_id !== 'string' ||
    !UPSTREAM_CALL_ID_PATTERN.test(item.call_id) ||
    item.status !== 'completed' ||
    seenItemIds.has(item.id) ||
    seenCallIds.has(item.call_id)
  ) {
    protocolFailure();
  }
  seenItemIds.add(item.id);
  seenCallIds.add(item.call_id);
  return { itemId: item.id, callId: item.call_id };
}

function parseNativeOutput(
  output: unknown,
  selectorName: string | undefined,
  admission: ResponsesImageAdmission,
): NativeResponsesImageSelectionResult {
  if (!Array.isArray(output) || output.length > 1_024) protocolFailure();
  const calls: ResponsesSelectedImageCall[] = [];
  const imageCalls: NativeResponsesSelectedImageCall[] = [];
  const internalItemIds: string[] = [];
  const otherTools: ResponsesHostedToolIdentity[] = [];
  const seenItemIds = new Set<string>();
  const seenCallIds = new Set<string>();
  const addOtherTool = (identity: ResponsesHostedToolIdentity): void => {
    otherTools.push(identity);
  };
  for (let itemIndex = 0; itemIndex < output.length; itemIndex += 1) {
    const item = output[itemIndex];
    if (!isRecord(item)) protocolFailure();
    if (
      selectorName !== undefined &&
      item.type === 'function_call' &&
      item.name === selectorName
    ) {
      if (Object.keys(item).some((key) => !SELECTOR_ITEM_KEYS.has(key))) protocolFailure();
      const identity = validateToolCallIdentity(item, seenItemIds, seenCallIds);
      const call = parseSelectorPrompt(item.arguments);
      calls.push(call);
      imageCalls.push(Object.freeze({
        call,
        presentationIndex: itemIndex,
        upstreamCallId: identity.callId,
        itemIndex,
      }));
      internalItemIds.push(identity.itemId);
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      validateToolCallIdentity(item, seenItemIds, seenCallIds);
      const declared = declaredOtherTool(admission, item);
      if (!declared) protocolFailure();
      addOtherTool(declared);
      continue;
    }
    const declaredHosted = declaredOtherTool(admission, item);
    if (declaredHosted) {
      if (
        typeof item.id !== 'string' ||
        !WIRE_ITEM_ID_PATTERN.test(item.id) ||
        item.status !== 'completed' ||
        seenItemIds.has(item.id)
      ) {
        protocolFailure();
      }
      seenItemIds.add(item.id);
      addOtherTool(declaredHosted);
    } else if (
      typeof item.type === 'string' &&
      Object.prototype.hasOwnProperty.call(HOSTED_CALL_DECLARATION_TYPES, item.type)
    ) {
      protocolFailure();
    }
  }
  return Object.freeze({
    selection: Object.freeze({
      imageCalls: Object.freeze(calls),
      otherToolCount: otherTools.length,
      otherTools: Object.freeze(otherTools),
    }),
    imageCalls: Object.freeze(imageCalls),
    internalItemIds: Object.freeze(internalItemIds),
  });
}

export function prepareNativeResponsesImageSelection(
  input: PrepareNativeResponsesImageSelectionInput,
): NativeResponsesImageSelectionPreparation {
  const tools = Array.isArray(input.body.tools)
    ? input.body.tools.map((tool) => isRecord(tool) ? { ...tool } : tool)
    : undefined;
  const selectorName = input.admission.declared
    ? createNonCollidingSelectorName(
        tools ?? [],
        input.createSelectorName ?? (() => `__omnicross_image_${randomUUID().replaceAll('-', '')}`),
      )
    : undefined;
  if (
    selectorName !== undefined &&
    tools !== undefined &&
    input.admission.imageToolIndex !== undefined
  ) {
    tools[input.admission.imageToolIndex] = selectorDeclaration(selectorName);
  }
  const upstreamBody: Record<string, unknown> = {
    ...input.body,
    ...(tools !== undefined ? { tools } : {}),
    ...(input.body.input !== undefined
      ? { input: cloneInputWithoutLocalImageCalls(input.body.input) }
      : {}),
  };
  const receipts = pendingReceiptItems(input.pendingReceipts);
  if (receipts.length > 0) {
    upstreamBody.input = [
      ...receipts,
      ...inputItemsForReceiptInjection(input.body.input),
    ];
  }
  if (input.admission.selectionPolicy.kind === 'forced_image' && selectorName !== undefined) {
    upstreamBody.tool_choice = { type: 'function', name: selectorName };
  } else if (isRecord(input.body.tool_choice)) {
    upstreamBody.tool_choice = { ...input.body.tool_choice };
  }
  return Object.freeze({
    upstreamBody,
    ...(selectorName !== undefined ? { selectorName } : {}),
    parseOutput: (output: unknown): NativeResponsesImageSelectionResult =>
      parseNativeOutput(output, selectorName, input.admission),
  });
}

/**
 * Shallow ownership predicate for the optional hosted-image ingress seam.
 * Natural-language input is deliberately outside this check.
 */
export function hasImageOwnedResponsesInput(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (
    Array.isArray(body.tools) &&
    body.tools.some((tool) => isRecord(tool) && tool.type === 'image_generation')
  ) {
    return true;
  }
  if (isRecord(body.tool_choice) && body.tool_choice.type === 'image_generation') {
    return true;
  }
  return Array.isArray(body.input) && body.input.some(
    (item) => isRecord(item) && item.type === 'image_generation_call',
  );
}
