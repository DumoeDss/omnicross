/**
 * Managed-search selection for the Responses frontend.
 *
 * The mechanism is the hosted-image precedent, applied to search: the upstream
 * cannot run OUR providers, so the hosted `web_search` declaration it would
 * execute itself is swapped for an ordinary function tool the model can call.
 * When the model calls that selector, Omnicross knows the query and runs the
 * search through `SearchRuntime`.
 *
 * The declaration types come from the ONE shared table
 * (`HOSTED_CALL_DECLARATION_TYPES.web_search_call`, wire baseline R6), so the
 * hosted-image and hosted-search lanes cannot drift apart on what a hosted
 * search declaration looks like.
 *
 * @module provider-proxy/responses/hosted-search/nativeResponsesSearchSelection
 */

import { randomUUID } from 'node:crypto';

import { HOSTED_CALL_DECLARATION_TYPES } from '../hosted-image/nativeResponsesImageSelection';

/** The declaration types that produce a `web_search_call` output item. */
export const SEARCH_DECLARATION_TYPES: readonly string[] =
  HOSTED_CALL_DECLARATION_TYPES['web_search_call'] ?? ['web_search_preview', 'web_search'];

const SELECTOR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_SELECTOR_NAME_ATTEMPTS = 16;
const MAX_QUERY_LENGTH = 4096;
/** Upper bound on selector calls honored in one turn. */
export const MAX_SELECTED_SEARCH_CALLS = 8;

const SELECTOR_DESCRIPTION =
  'Search the web for current information. Provide the search query.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
        query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
      },
      required: ['query'],
      additionalProperties: false,
    },
  };
}

function createNonCollidingSelectorName(
  tools: readonly unknown[],
  createName: () => string,
): string {
  const declared = new Set(
    tools.flatMap((tool) => isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []),
  );
  for (let attempt = 0; attempt < MAX_SELECTOR_NAME_ATTEMPTS; attempt += 1) {
    const candidate = createName();
    if (SELECTOR_NAME_PATTERN.test(candidate) && !declared.has(candidate)) return candidate;
  }
  throw new Error('managed search could not mint a non-colliding selector name');
}

/** What the mediator needs to remember between preparing and wrapping. */
export interface NativeResponsesSearchSelection {
  /** The rewritten body sent upstream. */
  readonly upstreamBody: Record<string, unknown>;
  /** The function-tool name standing in for the hosted declaration. */
  readonly selectorName: string;
  /** Whether the CLIENT asked for a stream (the upstream turn never streams). */
  readonly clientWantsStream: boolean;
}

export interface PrepareNativeResponsesSearchSelectionInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly createSelectorName?: () => string;
}

/**
 * Rewrite a hosted-search request for managed execution.
 *
 * Two changes and no others: hosted search declarations become the selector
 * function, and `stream` is forced off. Everything else about the request —
 * other tools, input, model, sampling — is passed through untouched, because
 * managed search is about who runs the SEARCH, not about editing the turn.
 */
export function prepareNativeResponsesSearchSelection(
  input: PrepareNativeResponsesSearchSelectionInput,
): NativeResponsesSearchSelection {
  const tools = Array.isArray(input.body.tools)
    ? input.body.tools.map((tool) => (isRecord(tool) ? { ...tool } : tool))
    : [];
  const selectorName = createNonCollidingSelectorName(
    tools,
    input.createSelectorName ?? (() => `__omnicross_search_${randomUUID().replaceAll('-', '')}`),
  );

  let replaced = false;
  const rewritten = tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.type !== 'string') return tool;
    if (!SEARCH_DECLARATION_TYPES.includes(tool.type)) return tool;
    replaced = true;
    return selectorDeclaration(selectorName);
  });
  if (!replaced) rewritten.push(selectorDeclaration(selectorName));

  const upstreamBody: Record<string, unknown> = {
    ...input.body,
    tools: rewritten,
    // The upstream turn is deliberately NOT streamed; see the mediator.
    stream: false,
  };

  // A `tool_choice` naming the hosted type must follow the swap, or the model
  // is told to call a tool that no longer exists.
  const choice = input.body.tool_choice;
  if (
    isRecord(choice) && typeof choice.type === 'string' &&
    SEARCH_DECLARATION_TYPES.includes(choice.type)
  ) {
    upstreamBody.tool_choice = { type: 'function', name: selectorName };
  }

  return Object.freeze({
    upstreamBody,
    selectorName,
    clientWantsStream: input.body.stream === true,
  });
}

/** One selector call the model made, located in the upstream output array. */
export interface SelectedSearchCall {
  readonly query: string;
  readonly itemIndex: number;
  readonly upstreamCallId: string;
  readonly upstreamItemId: string;
}

/**
 * Find the selector calls in an upstream output array.
 *
 * Anything that is not a well-formed selector call is IGNORED rather than
 * treated as a protocol failure: the rest of the turn is the upstream's own
 * output and this lane has no business rejecting it.
 */
export function parseSelectedSearchCalls(
  output: unknown,
  selectorName: string,
): SelectedSearchCall[] {
  if (!Array.isArray(output)) return [];
  const calls: SelectedSearchCall[] = [];
  for (let itemIndex = 0; itemIndex < output.length; itemIndex += 1) {
    if (calls.length >= MAX_SELECTED_SEARCH_CALLS) break;
    const item = output[itemIndex];
    if (!isRecord(item) || item.type !== 'function_call' || item.name !== selectorName) continue;
    const query = parseSelectorArguments(item.arguments);
    if (query === undefined) continue;
    calls.push(Object.freeze({
      query,
      itemIndex,
      upstreamCallId: typeof item.call_id === 'string' ? item.call_id : '',
      upstreamItemId: typeof item.id === 'string' ? item.id : '',
    }));
  }
  return calls;
}

function parseSelectorArguments(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 * 1024) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') return undefined;
  const query = parsed.query.trim();
  return query && query.length <= MAX_QUERY_LENGTH ? query : undefined;
}
