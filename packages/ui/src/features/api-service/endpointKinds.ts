/**
 * endpointKinds.ts — the model-KIND vocabulary + client-side completeness
 * derivation for the API Service routing editor (model-kind-mapping surface).
 *
 * `ENDPOINT_MODEL_KINDS` is a hand-mirror of mkm-core's SSOT
 * (`@omnicross/core/outbound-api` `ENDPOINT_MODEL_KINDS`). The ui package
 * deliberately carries no `@omnicross/core` dependency (same convention as the
 * `types-server.ts` / `types-usage-pricing.ts` DTO mirrors — it ships as
 * standalone static assets), so the tiny kind vocabulary is re-declared here.
 * If core's kinds change, update here in lockstep. The daemon enforces the real
 * startup gate with core's `validateServerModelConfig`; this module only drives
 * the editor's pickers + the client-side "service can't start" prompt.
 */

import type { EndpointRoutingConfig, OutboundEndpointId } from '@/daemon/types';

/**
 * MIRROR of `@omnicross/core` outbound-api `ENDPOINT_MODEL_KINDS` — keep in sync;
 * the `@omnicross/ui` package intentionally has NO core runtime dep (it ships as
 * standalone static assets). This is the ONLY unavoidable mirror of the kinds
 * (the daemon imports the real constant/predicate from core). `endpointKinds.test.ts`
 * pins these exact values so an accidental UI-side edit is caught.
 *
 * The canonical model KINDS per kind-mapped endpoint (declaration order = render
 * order). `messages` (Claude Code) routes fable/opus/sonnet/haiku; `responses`
 * (Codex) routes codex/mini. `chat`/`gemini` are role-based (not here).
 */
export const ENDPOINT_MODEL_KINDS = {
  messages: ['fable', 'opus', 'sonnet', 'haiku'],
  responses: ['codex', 'mini'],
} as const;

/** The endpoints that route by model kind (`messages` | `responses`). */
export type KindMappedEndpointId = keyof typeof ENDPOINT_MODEL_KINDS;

/** Narrow an endpoint id to the kind-mapped set. */
export function isKindMappedEndpoint(
  endpoint: OutboundEndpointId,
): endpoint is KindMappedEndpointId {
  return endpoint === 'messages' || endpoint === 'responses';
}

/** The declared kinds for a kind-mapped endpoint (in render order). */
export function modelKindsForEndpoint(
  endpoint: KindMappedEndpointId,
): readonly string[] {
  return ENDPOINT_MODEL_KINDS[endpoint];
}

/** A ref counts as configured only when it is a non-empty trimmed string. */
function isBlankRef(ref: string | undefined): boolean {
  return !ref || ref.trim() === '';
}

/**
 * The kinds THIS endpoint declares but leaves unconfigured (blank/absent ref).
 * Role-based endpoints (`chat`/`gemini`) have no declared kinds → `[]`. Mirrors
 * mkm-core's `validateEndpointModelConfig` for the client-side prompt.
 */
export function missingKindsForEndpoint(
  endpoint: EndpointRoutingConfig,
): string[] {
  if (!isKindMappedEndpoint(endpoint.endpoint)) return [];
  const map = endpoint.modelMap ?? {};
  return modelKindsForEndpoint(endpoint.endpoint).filter((kind) =>
    isBlankRef(map[kind]),
  );
}

/** One incomplete endpoint + the kinds it is missing. */
export interface EndpointMissingKinds {
  endpoint: KindMappedEndpointId;
  missingKinds: string[];
}

/**
 * Per-endpoint missing-kind summary across a whole server config — the
 * client-side mirror of mkm-core's `validateServerModelConfig`, used to render
 * the "service can't start: missing model mappings" banner. Returns one entry
 * per kind-mapped endpoint that has any blank required kind; empty ⇒ complete.
 */
export function missingKindsByEndpoint(
  endpoints: EndpointRoutingConfig[],
): EndpointMissingKinds[] {
  const out: EndpointMissingKinds[] = [];
  for (const ep of endpoints) {
    if (!isKindMappedEndpoint(ep.endpoint)) continue;
    const missingKinds = missingKindsForEndpoint(ep);
    if (missingKinds.length > 0) out.push({ endpoint: ep.endpoint, missingKinds });
  }
  return out;
}
