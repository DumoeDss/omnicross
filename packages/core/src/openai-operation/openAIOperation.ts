/**
 * Stable identities for the OpenAI-compatible HTTP operations Omnicross knows.
 *
 * Classification is deliberately closed and path-only. Adapters can vary how
 * an extension-owned operation is implemented, but cannot claim new public
 * paths at runtime.
 *
 * @module openai-operation/openAIOperation
 */

export type OpenAIOperationId =
  | 'chat.completions.create'
  | 'responses.create'
  | 'responses.compact'
  | 'images.generate'
  | 'images.edit';

export type OpenAIPolicyFamily = 'chat' | 'responses' | 'images';
export type OpenAIRouteFamily = OpenAIPolicyFamily;
export type OpenAIOperationOwner = 'builtin' | 'extension';
export type OpenAIOperationBodyKind = 'json' | 'multipart';
export type OpenAIRequestedModelSource = 'request' | 'configured';

export interface OpenAIOperation {
  readonly id: OpenAIOperationId;
  readonly policyFamily: OpenAIPolicyFamily;
  readonly routeFamily: OpenAIRouteFamily;
  readonly owner: OpenAIOperationOwner;
  readonly bodyKind: OpenAIOperationBodyKind;
  readonly requestedModelSource: OpenAIRequestedModelSource;
}

export type ExtensionOpenAIOperationId =
  | 'responses.compact'
  | 'images.generate'
  | 'images.edit';

const OPERATIONS = {
  'chat.completions.create': {
    id: 'chat.completions.create',
    policyFamily: 'chat',
    routeFamily: 'chat',
    owner: 'builtin',
    bodyKind: 'json',
    requestedModelSource: 'request',
  },
  'responses.create': {
    id: 'responses.create',
    policyFamily: 'responses',
    routeFamily: 'responses',
    owner: 'builtin',
    bodyKind: 'json',
    requestedModelSource: 'request',
  },
  'responses.compact': {
    id: 'responses.compact',
    policyFamily: 'responses',
    routeFamily: 'responses',
    owner: 'extension',
    bodyKind: 'json',
    requestedModelSource: 'request',
  },
  'images.generate': {
    id: 'images.generate',
    policyFamily: 'images',
    routeFamily: 'images',
    owner: 'extension',
    bodyKind: 'json',
    requestedModelSource: 'configured',
  },
  'images.edit': {
    id: 'images.edit',
    policyFamily: 'images',
    routeFamily: 'images',
    owner: 'extension',
    bodyKind: 'multipart',
    requestedModelSource: 'configured',
  },
} as const satisfies Record<OpenAIOperationId, OpenAIOperation>;

const MATCH_ORDER: ReadonlyArray<{
  readonly id: OpenAIOperationId;
  readonly suffix: readonly string[];
}> = [
  { id: 'responses.compact', suffix: ['responses', 'compact'] },
  { id: 'images.generate', suffix: ['images', 'generations'] },
  { id: 'images.edit', suffix: ['images', 'edits'] },
  { id: 'chat.completions.create', suffix: ['chat', 'completions'] },
  { id: 'responses.create', suffix: ['responses'] },
];

export function getOpenAIOperation(id: OpenAIOperationId): OpenAIOperation {
  return OPERATIONS[id];
}

function pathSegments(url: string): string[] {
  const queryIndex = url.indexOf('?');
  const path = queryIndex >= 0 ? url.slice(0, queryIndex) : url;
  return path.split('/').filter(Boolean);
}

function hasExactSuffix(segments: readonly string[], suffix: readonly string[]): boolean {
  if (segments.length < suffix.length) return false;
  const offset = segments.length - suffix.length;
  return suffix.every((segment, index) => segments[offset + index] === segment);
}

/** Classify a supported OpenAI operation under any base-path prefix. */
export function classifyOpenAIOperation(
  method: string | undefined,
  url: string | undefined,
): OpenAIOperation | null {
  if (method !== 'POST' || !url) return null;
  const segments = pathSegments(url);
  for (const candidate of MATCH_ORDER) {
    if (hasExactSuffix(segments, candidate.suffix)) return OPERATIONS[candidate.id];
  }
  return null;
}
