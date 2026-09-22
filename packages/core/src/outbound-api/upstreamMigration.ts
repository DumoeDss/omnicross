/**
 * upstreamMigration — P4 of the upstream routing model
 * (`docs/design/upstream-routing-model.md`, D7): one-time conversion of the
 * stored downstream routes into the two-concept model — per-key ordered
 * upstream sets + per-upstream mapping tables.
 *
 * The LEGACY routes stay stored (they keep serving any key that was never
 * migrated); migration is idempotent (keys that already carry an
 * `upstreamBinding` are skipped) and reversible wholesale (clear the fields).
 *
 * Mapping merge rules (per upstream, rows merged by `source`, FIRST wins;
 * losers are reported as conflicts for the operator):
 * - `modelMappings` rows carry over verbatim (bare model ids);
 * - kind maps: responses `codex`→`*`, `mini`→`*mini*`; messages each kind →
 *   `*<kind>*` (the same wildcard conventions the routes UI used);
 * - chat `models` lists become identity rows; prefix targets become the
 *   `claude-*` / `gpt-*` / `gemini-*` family wildcards;
 * - gemini `defaultModel`/`backgroundModel` become the `default`/`background`
 *   role rows.
 *
 * Pure module — no I/O; the daemon persists the result.
 *
 * @module @omnicross/core/outbound-api/upstreamMigration
 */

import { candidateGatewayBindings } from './gatewayBindingResolver';
import {
  ENDPOINT_MODEL_KINDS,
  type GatewayBinding,
  type GatewayBindingTarget,
  type GatewayModelMapping,
  type KeyUpstreamBinding,
  type OutboundEndpoint,
} from './types';

/** A same-source mapping collision the merge resolved by keeping the first. */
export interface UpstreamMigrationConflict {
  upstreamKey: string;
  source: string;
  kept: string;
  dropped: string;
}

export interface UpstreamMigrationResult {
  /** Materialized bindings, one per previously-unmigrated key. */
  keyBindings: Array<{ keyId: string; binding: KeyUpstreamBinding }>;
  /** Merged per-upstream mapping tables (`providerId` / `sub:<providerId>`). */
  mappingTables: Record<string, GatewayModelMapping[]>;
  /** Same-source collisions (first won) — surfaced to the operator. */
  conflicts: UpstreamMigrationConflict[];
  /** Keys whose legacy candidates were empty (now deliberate explicit-empty). */
  emptyKeys: string[];
}

/** The bare model id of a `"providerId,modelId"` (or bare) ref. */
function bareModelId(ref: string): string {
  const comma = ref.indexOf(',');
  return (comma >= 0 ? ref.slice(comma + 1) : ref).trim();
}

/** The mapping-table key of a legacy target. */
export function upstreamKeyOfTarget(target: GatewayBindingTarget): string {
  return target.kind === 'provider' ? target.providerId : `sub:${target.providerId}`;
}

/** Project ONE legacy binding's model config into mapping rows. */
function bindingToMappingRows(binding: GatewayBinding): GatewayModelMapping[] {
  const rows: GatewayModelMapping[] = [];
  const push = (source: string, target: string | undefined): void => {
    if (source.trim() !== '' && target && target.trim() !== '') rows.push({ source: source.trim(), target: target.trim() });
  };
  for (const row of binding.modelMappings ?? []) {
    if (row.source.trim() && row.target.trim()) rows.push({ ...row, source: row.source.trim(), target: row.target.trim() });
  }
  if (binding.endpoint === 'responses') {
    push('*', binding.modelMap?.codex);
    push('*mini*', binding.modelMap?.mini);
  } else if (binding.endpoint === 'messages') {
    for (const kind of ENDPOINT_MODEL_KINDS.messages) push(`*${kind}*`, binding.modelMap?.[kind]);
  } else if (binding.endpoint === 'chat') {
    if (binding.dispatchMode === 'prefix') {
      push('claude-*', binding.prefixTargets?.claude);
      push('gpt-*', binding.prefixTargets?.gpt);
      push('gemini-*', binding.prefixTargets?.gemini);
    } else {
      for (const model of binding.models ?? []) push(bareModelId(model), model);
    }
  } else if (binding.endpoint === 'gemini') {
    push('default', binding.defaultModel);
    push('background', binding.backgroundModel);
  }
  return rows;
}

/**
 * Run the conversion. Key ordering: each key's candidate targets are collected
 * endpoint by endpoint (chat → responses → messages → gemini), in candidate
 * (priority) order, first-seen wins — the closest faithful projection of the
 * legacy per-endpoint sets onto ONE ordered list.
 */
export function migrateLegacyBindingsToUpstreams(input: {
  bindings: readonly GatewayBinding[];
  keys: ReadonlyArray<{ id: string; upstreamBinding?: KeyUpstreamBinding }>;
}): UpstreamMigrationResult {
  const endpoints: readonly OutboundEndpoint[] = ['chat', 'responses', 'messages', 'gemini'];
  const keyBindings: UpstreamMigrationResult['keyBindings'] = [];
  const emptyKeys: string[] = [];

  for (const key of input.keys) {
    if (key.upstreamBinding) continue; // already migrated — idempotent
    const seen = new Set<string>();
    const targets: GatewayBindingTarget[] = [];
    for (const endpoint of endpoints) {
      for (const candidate of candidateGatewayBindings(input.bindings, key.id, endpoint)) {
        const id = JSON.stringify(candidate.target);
        if (seen.has(id)) continue;
        seen.add(id);
        targets.push(candidate.target);
      }
    }
    if (targets.length === 0) emptyKeys.push(key.id);
    keyBindings.push({ keyId: key.id, binding: { mode: 'explicit', targets } });
  }

  // Mapping tables: merge every binding's rows into its target's table,
  // preserving binding order; same-source collisions keep the FIRST and are
  // reported.
  const tables = new Map<string, Map<string, GatewayModelMapping>>();
  const conflicts: UpstreamMigrationConflict[] = [];
  for (const binding of input.bindings) {
    const tableKey = upstreamKeyOfTarget(binding.target);
    let table = tables.get(tableKey);
    if (!table) {
      table = new Map();
      tables.set(tableKey, table);
    }
    for (const row of bindingToMappingRows(binding)) {
      const { source, target } = row;
      const value = bareModelId(target);
      const existing = table.get(source);
      if (existing) {
        if (existing.target !== value) {
          conflicts.push({
            upstreamKey: tableKey,
            source,
            kept: existing.target,
            dropped: value,
          });
        }
        continue;
      }
      table.set(source, { ...row, source, target: value });
    }
  }

  return {
    keyBindings,
    mappingTables: Object.fromEntries(
      [...tables.entries()]
        .filter(([, rows]) => rows.size > 0)
        .map(([key, rows]) => [key, [...rows.values()]]),
    ),
    conflicts,
    emptyKeys,
  };
}
