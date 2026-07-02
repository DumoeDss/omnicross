/**
 * kindDetection — classify an outbound request's model KIND for the kind-mapped
 * endpoints (`messages`/`responses`) and validate their config completeness
 * (`outbound-api-server`, model-kind-mapping contract).
 *
 * The kind-mapped endpoints route by a version-INDEPENDENT model KIND rather
 * than by role: the user configures one upstream ref per kind
 * ({@link ENDPOINT_MODEL_KINDS}) and an incoming versioned client id
 * (`claude-opus-4-8-2026xxxx`) is classified to its kind (`opus`) so CLI
 * upgrades need no reconfig. `chat`/`gemini` stay on `roleDetection`.
 *
 * Pure module — no I/O. The router decides, per endpoint, whether to call
 * `detectModelKind` (messages/responses) or `detectRequestRole` (chat/gemini);
 * the routing RESOLUTION and the startup-gate ENFORCEMENT live downstream.
 *
 * @module outbound-api/kindDetection
 */

import { normalizeModelId } from '@omnicross/contracts/canonical-models';

import { isBackgroundTierModel, modelTokens } from './roleDetection';
import {
  ENDPOINT_MODEL_KINDS,
  type EndpointRoutingConfig,
  type KindMappedEndpoint,
  type ModelKind,
  type OutboundApiServerConfig,
  type OutboundEndpoint,
} from './types';

/** A ref counts as configured only when it is a non-empty trimmed string. */
function isNonBlankRef(ref: unknown): boolean {
  return typeof ref === 'string' && ref.trim() !== '';
}

/**
 * Narrow an endpoint to the kind-mapped set (`messages`/`responses`). `chat`
 * and `gemini` are role-based and return false.
 */
export function isKindMappedEndpoint(
  endpoint: OutboundEndpoint,
): endpoint is KindMappedEndpoint {
  return Object.prototype.hasOwnProperty.call(ENDPOINT_MODEL_KINDS, endpoint);
}

/** The canonical kinds for a kind-mapped endpoint (in declaration order). */
export function modelKindsForEndpoint(
  endpoint: KindMappedEndpoint,
): readonly ModelKind[] {
  return ENDPOINT_MODEL_KINDS[endpoint];
}

/**
 * Extract the version-INDEPENDENT model KIND for a kind-mapped endpoint.
 *  - `messages`: the FIRST id token that is one of {fable,opus,sonnet,haiku};
 *    `undefined` when no token matches (the unmatched-kind fallback is SERVING's
 *    decision, not core's).
 *  - `responses`: `mini` when {@link isBackgroundTierModel}; else `codex`
 *    (codex is the else-branch — a present id always resolves).
 *  - Any empty/blank id ⇒ `undefined`.
 *
 * Reuses `normalizeModelId` + the shared `/[-._:/\s]+/` tokenizer
 * (`modelTokens`) + the small-tier token set (`isBackgroundTierModel`) so the
 * kind and role detectors stay token-boundary-consistent.
 */
export function detectModelKind(
  endpoint: KindMappedEndpoint,
  requestedModelId: string | undefined,
): ModelKind | undefined {
  if (!requestedModelId || requestedModelId.trim() === '') return undefined;

  if (endpoint === 'messages') {
    const declared = ENDPOINT_MODEL_KINDS.messages as readonly string[];
    for (const tok of modelTokens(normalizeModelId(requestedModelId))) {
      if (declared.includes(tok)) return tok as ModelKind;
    }
    return undefined;
  }

  // responses: small-tier → mini; everything else → codex.
  return isBackgroundTierModel(requestedModelId) ? 'mini' : 'codex';
}

/**
 * The kinds THIS endpoint declares but leaves unconfigured (blank/absent ref).
 * Role-based endpoints (`chat`/`gemini`) have no declared kinds → `[]`.
 * Absent and blank refs are treated identically; a malformed-but-non-blank ref
 * is a serving-time concern, not a startup-gate one.
 */
export function validateEndpointModelConfig(
  config: EndpointRoutingConfig,
): ModelKind[] {
  if (!isKindMappedEndpoint(config.endpoint)) return [];
  const map = config.modelMap ?? {};
  return modelKindsForEndpoint(config.endpoint).filter(
    (kind) => !isNonBlankRef(map[kind]),
  );
}

/** One incomplete kind-mapped endpoint and the kinds it is missing. */
export interface EndpointModelConfigError {
  endpoint: KindMappedEndpoint;
  missingKinds: ModelKind[];
}

/**
 * Server-level completeness, PER-ENDPOINT: a kind-mapped endpoint whose
 * declared kinds are ALL blank/absent counts as UNCONFIGURED — the operator
 * simply doesn't use that endpoint, so it does NOT block startup (its requests
 * 503 per-request instead). Only a PARTIALLY configured endpoint (some kinds
 * set, some blank — a real config mistake that would silently misroute) is
 * returned as an error. Empty result ⇒ the config satisfies the startup gate.
 *
 * Serving consumes this for the gate ENFORCEMENT; it MAY tighten to an
 * all-endpoints-strict policy by composing {@link validateEndpointModelConfig}.
 */
export function validateServerModelConfig(
  config: OutboundApiServerConfig,
): EndpointModelConfigError[] {
  const errors: EndpointModelConfigError[] = [];
  for (const endpoint of Object.keys(ENDPOINT_MODEL_KINDS) as KindMappedEndpoint[]) {
    const ep = config.endpoints.find((e) => e.endpoint === endpoint);
    const declared = modelKindsForEndpoint(endpoint);
    const missingKinds = ep ? validateEndpointModelConfig(ep) : [...declared];
    // Fully blank ⇒ endpoint unused ⇒ not a startup error.
    if (missingKinds.length > 0 && missingKinds.length < declared.length) {
      errors.push({ endpoint, missingKinds });
    }
  }
  return errors;
}
