/**
 * The narrow port the Responses ingress uses for MANAGED hosted search.
 *
 * Mirrors `responsesHostedImageIngress.ts`: the ingress owns only
 * prepare/wrap composition, and everything else lives behind this interface in
 * the injected mediator. Keeping the port here (rather than in the mediator)
 * is what lets the ingress depend on the shape without depending on the
 * implementation.
 *
 * @module provider-proxy/responses/responsesHostedSearchIngress
 */

import type { SearchFrontendMode } from '../../search/frontends';

import type { ResponsesProfile } from './responsesProfile';

export interface ResponsesHostedSearchPrepareInput {
  readonly body: Readonly<Record<string, unknown>>;
  readonly profile: ResponsesProfile;
  readonly operation: 'create' | 'compact';
  /** Resolved ONCE per request by the ingress, before any wire bytes. */
  readonly mode: SearchFrontendMode;
  readonly signal: AbortSignal;
}

export interface ResponsesHostedSearchWrapInput {
  readonly response: Response;
  readonly rawStatus: number | null;
}

export interface ResponsesHostedSearchRequestLease {
  /**
   * What actually goes upstream.
   *
   * Managed mode replaces the hosted search declaration with a function-tool
   * selector (the hosted-image precedent) and forces `stream: false` — see the
   * mediator for why the upstream turn is never streamed.
   */
  readonly upstreamBody: Record<string, unknown>;
  wrapUpstreamResponse(input: ResponsesHostedSearchWrapInput): Promise<Response>;
}

export interface ResponsesHostedSearchIngress {
  prepare(
    input: ResponsesHostedSearchPrepareInput,
  ): Promise<ResponsesHostedSearchRequestLease | null>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Declaration types that mean "this request wants a hosted web search". */
export const HOSTED_SEARCH_DECLARATION_TYPES: readonly string[] = Object.freeze([
  'web_search_preview',
  'web_search',
]);

/**
 * Cheap ownership predicate — does this request declare a hosted web search?
 *
 * Full validation stays inside the mediator, exactly as it does for images.
 */
export function hasResponsesHostedSearchWork(
  body: Readonly<Record<string, unknown>>,
): boolean {
  if (
    Array.isArray(body.tools) &&
    body.tools.some(
      (tool) => record(tool) && typeof tool.type === 'string' &&
        HOSTED_SEARCH_DECLARATION_TYPES.includes(tool.type),
    )
  ) {
    return true;
  }
  return record(body.tool_choice) &&
    typeof body.tool_choice.type === 'string' &&
    HOSTED_SEARCH_DECLARATION_TYPES.includes(body.tool_choice.type);
}
