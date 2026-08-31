import { ImageGenerationError } from '../errors';
import { DEFAULT_IMAGE_API_LIMITS, type ImageApiRuntime } from '../openai-images/types';
import { normalizeImageOptions } from '../openai-images/normalizeOptions';
import type {
  ResponsesHostedToolIdentity,
  ResponsesHostedToolSelection,
  ResponsesImageAction,
  ResponsesImageAdmission,
  ResponsesImageCallId,
  ResponsesImageInspectionInput,
  ResponsesImageNormalizedOptions,
  ResponsesImageSelectionPolicy,
  ResponsesSelectedImageCall,
} from './types';

const IMAGE_DECLARATION_KEYS = new Set([
  'type',
  'action',
  'size',
  'quality',
  'output_format',
  'output_compression',
  'background',
  'partial_images',
]);
const CALL_ID_PATTERN = /^ig_[A-Za-z0-9_-]{16,128}$/;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const TOOL_IDENTITY_KEYS = new Set(['declarationIndex', 'type', 'name']);
const MAX_SELECTED_TOOL_CALLS = 1_024;

const NORMALIZATION_RUNTIME: ImageApiRuntime = {
  tenantId: 'responses-image-inspection',
  providerId: 'responses-image-inspection',
  defaultModel: 'responses-image-model',
  modelAliases: new Map(),
  limits: DEFAULT_IMAGE_API_LIMITS,
};

function invalid(param?: string): never {
  throw new ImageGenerationError('invalid_image_request', { param });
}

function protocolFailure(): never {
  throw new ImageGenerationError('upstream_protocol_changed');
}

function record(value: unknown, param: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(param);
  return value as Record<string, unknown>;
}

function parseSelectionPolicy(value: unknown): ResponsesImageSelectionPolicy {
  if (value === undefined || value === 'auto') return { kind: 'auto' };
  if (value === 'required') return { kind: 'required' };
  if (value === 'none') return { kind: 'none' };
  const choice = record(value, 'tool_choice');
  if (typeof choice.type !== 'string' || !choice.type.trim() || choice.type.length > 128) {
    invalid('tool_choice');
  }
  if (choice.type === 'image_generation') {
    if (Object.keys(choice).some((key) => key !== 'type')) invalid('tool_choice');
    return { kind: 'forced_image' };
  }
  if (Object.keys(choice).some((key) => key !== 'type' && key !== 'name')) {
    invalid('tool_choice');
  }
  if (
    choice.name !== undefined &&
    (typeof choice.name !== 'string' || !choice.name.trim() || choice.name.length > 128)
  ) {
    invalid('tool_choice');
  }
  return {
    kind: 'forced_other',
    toolType: choice.type,
    ...(choice.name !== undefined ? { toolName: choice.name } : {}),
  };
}

function declaredOtherToolIdentity(
  value: Record<string, unknown>,
  declarationIndex: number,
): ResponsesHostedToolIdentity | undefined {
  if (typeof value.type !== 'string' || !value.type.trim() || value.type.length > 128) {
    return undefined;
  }
  if (
    value.name !== undefined &&
    (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128)
  ) {
    return undefined;
  }
  return Object.freeze({
    declarationIndex,
    type: value.type,
    ...(value.name !== undefined ? { name: value.name } : {}),
  });
}

function sameToolIdentity(
  left: ResponsesHostedToolIdentity,
  right: ResponsesHostedToolIdentity,
): boolean {
  return left.declarationIndex === right.declarationIndex &&
    left.type === right.type &&
    left.name === right.name;
}

function forcedOtherMatches(
  policy: Extract<ResponsesImageSelectionPolicy, { readonly kind: 'forced_other' }>,
  identity: ResponsesHostedToolIdentity,
): boolean {
  return identity.type === policy.toolType && identity.name === policy.toolName;
}

function parsePreviousResponseId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !RESPONSE_ID_PATTERN.test(value)) {
    invalid('previous_response_id');
  }
  return value;
}

function parseExplicitCallIds(value: unknown): readonly ResponsesImageCallId[] {
  if (value === undefined || typeof value === 'string') return Object.freeze([]);
  if (!Array.isArray(value)) invalid('input');
  const ids: ResponsesImageCallId[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== 'image_generation_call') continue;
    if (Object.keys(candidate).some((key) => key !== 'type' && key !== 'id')) invalid('input');
    if (typeof candidate.id !== 'string' || !CALL_ID_PATTERN.test(candidate.id)) invalid('input');
    ids.push(candidate.id as ResponsesImageCallId);
  }
  return Object.freeze(ids);
}

function parseDeclaration(value: Record<string, unknown>, stream: boolean): ResponsesImageNormalizedOptions {
  for (const key of Object.keys(value)) {
    if (!IMAGE_DECLARATION_KEYS.has(key)) invalid(`tools.${key}`);
  }
  const action = value.action === undefined ? 'auto' : value.action;
  if (action !== 'auto' && action !== 'generate' && action !== 'edit') invalid('tools.action');
  const options = normalizeImageOptions(
    {
      prompt: 'responses image selection',
      model: NORMALIZATION_RUNTIME.defaultModel,
      n: 1,
      moderation: 'auto',
      stream,
      ...(value.size !== undefined ? { size: value.size } : {}),
      ...(value.quality !== undefined ? { quality: value.quality } : {}),
      ...(value.output_format !== undefined ? { output_format: value.output_format } : {}),
      ...(value.output_compression !== undefined
        ? { output_compression: value.output_compression }
        : {}),
      ...(value.background !== undefined ? { background: value.background } : {}),
      ...(value.partial_images !== undefined ? { partial_images: value.partial_images } : {}),
    },
    NORMALIZATION_RUNTIME,
    { action: 'generate' },
  );
  return Object.freeze({
    action: action as ResponsesImageAction,
    quality: options.quality,
    size: options.size,
    background: options.background,
    outputFormat: options.outputFormat,
    ...(options.outputCompression !== undefined
      ? { outputCompression: options.outputCompression }
      : {}),
    partialImages: options.partialImages,
  });
}

export function inspectResponsesImageRequest(
  input: ResponsesImageInspectionInput,
): ResponsesImageAdmission {
  if (!input || typeof input !== 'object') invalid();
  const stream = input.stream === undefined ? false : input.stream;
  if (typeof stream !== 'boolean') invalid('stream');
  const tools = input.tools === undefined ? [] : input.tools;
  if (!Array.isArray(tools)) invalid('tools');
  let imageToolIndex: number | undefined;
  let declaration: ResponsesImageNormalizedOptions | undefined;
  let otherToolCount = 0;
  const otherTools: ResponsesHostedToolIdentity[] = [];
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      otherToolCount += 1;
      continue;
    }
    const candidate = tool as Record<string, unknown>;
    if (candidate.type !== 'image_generation') {
      otherToolCount += 1;
      const identity = declaredOtherToolIdentity(candidate, index);
      if (identity) otherTools.push(identity);
      continue;
    }
    if (imageToolIndex !== undefined) invalid('tools');
    imageToolIndex = index;
    declaration = parseDeclaration(candidate, stream);
  }
  const selectionPolicy = parseSelectionPolicy(input.tool_choice);
  if (selectionPolicy.kind === 'forced_image' && imageToolIndex === undefined) {
    invalid('tool_choice');
  }
  if (
    selectionPolicy.kind === 'forced_other' &&
    !otherTools.some((identity) => forcedOtherMatches(selectionPolicy, identity))
  ) {
    invalid('tool_choice');
  }
  const previousResponseId = parsePreviousResponseId(input.previous_response_id);
  return Object.freeze({
    declared: imageToolIndex !== undefined,
    ...(imageToolIndex !== undefined ? { imageToolIndex } : {}),
    otherToolCount,
    otherTools: Object.freeze(otherTools),
    stream,
    ...(previousResponseId !== undefined ? { previousResponseId } : {}),
    explicitCallIds: parseExplicitCallIds(input.input),
    selectionPolicy,
    ...(declaration ? { options: declaration } : {}),
  });
}

function validateSelectedCall(call: ResponsesSelectedImageCall): void {
  if (!call || typeof call !== 'object' || typeof call.prompt !== 'string') protocolFailure();
  if (!call.prompt.trim() || call.prompt.length > 32_000) protocolFailure();
  if (Object.keys(call as unknown as Record<string, unknown>).some((key) => key !== 'prompt')) {
    protocolFailure();
  }
}

function validateSelectedOtherTool(value: ResponsesHostedToolIdentity): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) protocolFailure();
  const candidate = value as unknown as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !TOOL_IDENTITY_KEYS.has(key))) protocolFailure();
  if (
    !Number.isSafeInteger(value.declarationIndex) ||
    value.declarationIndex < 0 ||
    typeof value.type !== 'string' ||
    !value.type.trim() ||
    value.type.length > 128 ||
    (value.name !== undefined &&
      (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128))
  ) {
    protocolFailure();
  }
}

export function validateResponsesImageSelection(
  admission: ResponsesImageAdmission,
  selection: ResponsesHostedToolSelection,
): void {
  if (
    !selection ||
    typeof selection !== 'object' ||
    Array.isArray(selection) ||
    !Array.isArray(selection.imageCalls) ||
    !Array.isArray(selection.otherTools) ||
    Object.keys(selection as unknown as Record<string, unknown>)
      .some((key) => key !== 'imageCalls' && key !== 'otherToolCount' && key !== 'otherTools')
  ) {
    protocolFailure();
  }
  if (
    !Number.isSafeInteger(selection.otherToolCount) ||
    selection.otherToolCount < 0 ||
    selection.otherToolCount !== selection.otherTools.length ||
    selection.imageCalls.length + selection.otherToolCount > MAX_SELECTED_TOOL_CALLS
  ) {
    protocolFailure();
  }
  selection.imageCalls.forEach(validateSelectedCall);
  selection.otherTools.forEach(validateSelectedOtherTool);
  if (selection.imageCalls.length > 0 && !admission.declared) protocolFailure();
  for (const selected of selection.otherTools) {
    if (!admission.otherTools.some((declared) => sameToolIdentity(declared, selected))) {
      protocolFailure();
    }
  }
  const selectedAny = selection.imageCalls.length + selection.otherToolCount > 0;
  switch (admission.selectionPolicy.kind) {
    case 'auto':
      return;
    case 'required':
      if (!selectedAny) protocolFailure();
      return;
    case 'none':
      if (selectedAny) protocolFailure();
      return;
    case 'forced_image':
      if (selection.imageCalls.length === 0 || selection.otherToolCount !== 0) protocolFailure();
      return;
    case 'forced_other': {
      const forcedOtherPolicy = admission.selectionPolicy;
      if (
        selection.imageCalls.length > 0 ||
        selection.otherTools.length === 0 ||
        selection.otherTools.some(
          (selected) => !forcedOtherMatches(forcedOtherPolicy, selected),
        )
      ) {
        protocolFailure();
      }
      return;
    }
    default:
      protocolFailure();
  }
}
