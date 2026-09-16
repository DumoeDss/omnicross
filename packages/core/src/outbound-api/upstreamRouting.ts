/**
 * upstreamRouting — the DERIVATION layer of the upstream routing model
 * (`docs/design/upstream-routing-model.md`).
 *
 * The user-facing model has two concepts — upstream resources (which own
 * model mappings) and access keys (which own an ORDERED upstream set).
 * This module derives, from those two inputs, the internal `GatewayBinding`
 * rows the existing resolver already consumes, so the whole serving engine
 * (candidates/scheduling, can-serve failover, mapping projection, endpoint
 * conversion, subscription dispatch, route pinning) keeps working unchanged.
 *
 * Derived binding shape, per (key, target, endpoint):
 * - `keyScope: 'selected'`, scoped to the key — so a migrated key's derived
 *   bindings occupy the scoped tier and suppress any legacy all-scope routes;
 * - `priority` = the target's index in the key's list (routing = list order);
 * - `fallback: 'next'` — a can-serve miss yields to the next upstream (D1);
 * - `modelMode: 'mapped'` + the upstream's NAME-keyed mapping rows when the
 *   upstream has any (exact-before-wildcard via the existing matcher), else
 *   `'passthrough'` (any non-blank model name serves; the client's id is
 *   forwarded verbatim);
 * - role-keyed rows (`default` / `background`, D6) are stripped from name
 *   matching and projected onto the gemini endpoint's default/background
 *   models, mirroring the legacy role-based route shape.
 *
 * Pure module — no I/O. The daemon assembles inputs and re-derives on every
 * key / upstream / mapping mutation.
 *
 * @module @omnicross/core/outbound-api/upstreamRouting
 */

import type {
  GatewayBinding,
  GatewayBindingTarget,
  GatewayModelMapping,
  KeyUpstreamBinding,
  OutboundEndpoint,
} from './types';

/** Every endpoint a derived binding covers — conversion is endpoint-agnostic. */
const DERIVED_ENDPOINTS: readonly OutboundEndpoint[] = ['chat', 'responses', 'messages', 'gemini'];

/**
 * Mapping sources that are ROLE keys rather than model names (D6): they never
 * participate in name matching and only the gemini endpoint consumes them.
 */
export const KEY_UPSTREAM_ROLE_KEYS: readonly string[] = Object.freeze(['default', 'background']);

export interface DeriveKeyUpstreamBindingsInput {
  apiKeyId: string;
  upstreamBinding: KeyUpstreamBinding;
  /** The live catalog of every upstream — the expansion of `mode:'all'`. */
  allUpstreams: readonly GatewayBindingTarget[];
  /**
   * The upstream's mapping table (name rows + role rows), or undefined/empty
   * for passthrough. Callers validate the table shape at their write edge.
   */
  mappingsFor: (target: GatewayBindingTarget) => readonly GatewayModelMapping[] | undefined;
  /** Optional display label for derived bindings (route activity shows it). */
  labelFor?: (target: GatewayBindingTarget) => string | undefined;
}

/** Split a mapping table into name rows and role rows (`default`/`background`). */
function splitRoleRows(
  table: readonly GatewayModelMapping[],
): { nameRows: GatewayModelMapping[]; defaultModel?: string; backgroundModel?: string } {
  const nameRows: GatewayModelMapping[] = [];
  let defaultModel: string | undefined;
  let backgroundModel: string | undefined;
  for (const row of table) {
    const source = row.source.trim();
    if (source === 'default') defaultModel ??= row.target;
    else if (source === 'background') backgroundModel ??= row.target;
    else nameRows.push(row);
  }
  return { nameRows, defaultModel, backgroundModel };
}

/** The effective ordered targets of one key's upstream binding. */
export function upstreamBindingTargets(
  binding: KeyUpstreamBinding,
  allUpstreams: readonly GatewayBindingTarget[],
): GatewayBindingTarget[] {
  return binding.mode === 'all' ? [...allUpstreams] : [...binding.targets];
}

/**
 * Derive the per-key, per-endpoint bindings of the upstream routing model.
 * An `explicit` binding with an empty list (or `'all'` with no upstreams)
 * yields `[]` — the key authenticates but serves nothing (the daemon answers
 * 403 "no upstream bound").
 */
export function deriveKeyUpstreamBindings(
  input: DeriveKeyUpstreamBindingsInput,
): GatewayBinding[] {
  const targets = upstreamBindingTargets(input.upstreamBinding, input.allUpstreams);
  const bindings: GatewayBinding[] = [];
  targets.forEach((target, index) => {
    const table = input.mappingsFor(target) ?? [];
    const { nameRows, defaultModel, backgroundModel } = splitRoleRows(table);
    for (const endpoint of DERIVED_ENDPOINTS) {
      const label = input.labelFor?.(target);
      const binding: GatewayBinding = {
        id: `keyup:${input.apiKeyId}:${index}:${endpoint}`,
        name: label ?? `upstream ${index + 1}`,
        enabled: true,
        keyScope: 'selected',
        apiKeyIds: [input.apiKeyId],
        endpoint,
        target,
        priority: index,
        fallback: 'next',
        modelMode: nameRows.length > 0 ? 'mapped' : 'passthrough',
        ...(nameRows.length > 0 ? { modelMappings: nameRows } : {}),
      };
      // Role keys land ONLY on the role-based endpoint, in the legacy shape:
      // default/background models + the id list background detection reads.
      // When role rows are present the gemini binding is ROLE-based — name
      // rows stop matching there and only feed background detection; without
      // role rows gemini keeps the generic name path like every endpoint.
      if (endpoint === 'gemini' && (defaultModel || backgroundModel)) {
        binding.modelMode = 'mapped';
        delete binding.modelMappings;
        if (defaultModel) binding.defaultModel = defaultModel;
        if (backgroundModel) binding.backgroundModel = backgroundModel;
        const backgroundIds = nameRows
          .filter((row) => backgroundModel !== undefined && row.target === backgroundModel)
          .map((row) => row.source.trim())
          .filter((source) => source !== '');
        if (backgroundIds.length > 0) binding.backgroundModelIds = backgroundIds;
      }
      bindings.push(binding);
    }
  });
  return bindings;
}

export interface AssembleGatewayBindingsInput {
  /** Every key row projection the derivation needs (id + optional binding). */
  keys: ReadonlyArray<{ id: string; upstreamBinding?: KeyUpstreamBinding }>;
  /** The live upstream catalog (`mode:'all'` expansion). */
  allUpstreams: readonly GatewayBindingTarget[];
  /** Per-upstream mapping tables. */
  mappingsFor: (target: GatewayBindingTarget) => readonly GatewayModelMapping[] | undefined;
  /** Optional display labels for derived bindings. */
  labelFor?: (target: GatewayBindingTarget) => string | undefined;
  /** The stored legacy downstream routes (`server.bindings`). */
  legacyBindings: readonly GatewayBinding[];
}

/**
 * Merge derived and legacy bindings into the live route aggregate.
 *
 * Keys WITH an `upstreamBinding` are MIGRATED: their derived bindings are
 * authoritative — legacy routes key-scoped to them are dropped, and legacy
 * all-scope routes are suppressed automatically by the scoped tier.
 * Keys WITHOUT one keep the legacy semantics untouched (per-key rollout).
 */
export function assembleGatewayBindings(input: AssembleGatewayBindingsInput): GatewayBinding[] {
  const migrated = new Set<string>();
  const derived: GatewayBinding[] = [];
  for (const key of input.keys) {
    if (!key.upstreamBinding) continue;
    migrated.add(key.id);
    derived.push(
      ...deriveKeyUpstreamBindings({
        apiKeyId: key.id,
        upstreamBinding: key.upstreamBinding,
        allUpstreams: input.allUpstreams,
        mappingsFor: input.mappingsFor,
        labelFor: input.labelFor,
      }),
    );
  }
  const isKeyScoped = (binding: GatewayBinding): boolean =>
    binding.keyScope === 'selected' ||
    (binding.keyScope === undefined && (binding.apiKeyIds?.length ?? 0) > 0);
  const legacy = input.legacyBindings.filter(
    (binding) =>
      !isKeyScoped(binding) || !(binding.apiKeyIds ?? []).some((id) => migrated.has(id)),
  );
  return [...derived, ...legacy];
}
