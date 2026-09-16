/**
 * upstreamRoutingAdmin — the daemon-side assembly of the upstream routing
 * model (`docs/design/upstream-routing-model.md`, P2).
 *
 * The user-facing model stores two things: per-key ordered upstream sets
 * (`OutboundKeyDbRow.upstreamBinding`) and per-upstream mapping tables
 * (`OutboundApiServerConfig.upstreamModelMappings`). This module derives the
 * LIVE route aggregate from them (plus the legacy stored routes for
 * not-yet-migrated keys) and hands it to `outboundApiServer.applyConfig` /
 * `prepareConfig`, so the serving engine keeps consuming plain
 * `GatewayBinding` rows.
 *
 * Every mutation of the inputs — key create / upstream-binding change, a
 * server-config PUT that touches mappings, a provider-catalog change — must be
 * followed by {@link liveServerConfigInput} (prepare/apply) so derivation is
 * never stale.
 *
 * @module @omnicross/daemon/admin/upstreamRoutingAdmin
 */

import {
  assembleGatewayBindings,
  loadServerConfig,
  migrateLegacyBindingsToUpstreams,
  saveServerConfig,
  type ApiServerSettingsStore,
  type GatewayBinding,
  type GatewayBindingTarget,
  type GatewayModelMapping,
  type KeyUpstreamBinding,
  type OutboundApiServerConfig,
  type UpstreamMigrationResult,
} from '@omnicross/core';

import { loadConfig } from '../config';

/** The minimal deps this module needs (structural — no adminApi import cycle). */
export interface UpstreamRoutingDeps {
  /** Path to the daemon's `config.json` (the BYO provider catalog). */
  readonly configPath: string;
  /** Named outbound-key store (the per-key upstream sets). */
  readonly keyDb: {
    outboundApiKeysList(): Promise<Array<{ id: string; upstreamBinding?: KeyUpstreamBinding }>>;
    outboundApiKeysSetUpstreamBinding(
      id: string,
      binding: KeyUpstreamBinding | null,
    ): Promise<boolean>;
  };
  /** Outbound server settings store (mapping tables + legacy routes). */
  readonly settingsStore: ApiServerSettingsStore;
  /** Subscription catalog (`listAll` — one entry per registered provider). */
  readonly subscriptionAccounts: { listAll(): Promise<unknown[]> };
  /**
   * Sanitized (token-free) per-provider account rows. A subscription pool
   * enters the catalog ONLY with ≥1 account — an empty pool would otherwise
   * claim any model name (passthrough can-serve) and black-hole requests.
   * Absent ⇒ no subscription upstreams at all (no store ⇒ no accounts).
   */
  readonly subscriptionTokenWriter?: {
    listSanitizedAccounts(): Promise<Record<string, unknown[]>>;
  };
}

/** One entry of the upstream catalog the UI editor lists. */
export interface UpstreamCatalogEntry {
  /** The mapping-table key (`providerId` or `sub:<providerId>`). */
  key: string;
  label: string;
  target: GatewayBindingTarget;
}

/** The mapping-table key of an upstream target. */
export function upstreamMappingKeyOf(target: GatewayBindingTarget): string {
  return target.kind === 'provider' ? target.providerId : `sub:${target.providerId}`;
}

/**
 * The full upstream catalog: every BYO provider row + every registered
 * subscription provider (as an account-pool target). Account pools with zero
 * accounts stay listed on purpose — binding to one is representable and fails
 * per-request exactly like an empty pool route, and it keeps the catalog
 * stable across account add/remove (no re-derivation triggers there).
 */
export async function listUpstreamCatalog(
  deps: UpstreamRoutingDeps,
): Promise<UpstreamCatalogEntry[]> {
  const providers = loadConfig(deps.configPath).providers ?? [];
  const rawSubscriptions = await deps.subscriptionAccounts.listAll().catch(() => [] as unknown[]);
  const subscriptions = rawSubscriptions
    .map((entry): { providerId: string; displayName?: string } | null => {
      if (!entry || typeof entry !== 'object') return null;
      const providerId = (entry as Record<string, unknown>)['providerId'];
      if (typeof providerId !== 'string' || providerId.trim() === '') return null;
      const displayName = (entry as Record<string, unknown>)['displayName'];
      return {
        providerId: providerId.trim(),
        ...(typeof displayName === 'string' ? { displayName } : {}),
      };
    })
    .filter((entry): entry is { providerId: string; displayName?: string } => entry !== null);
  // Only pools that actually hold an account enter the catalog (see the deps
  // doc: an empty pool is a request black hole under passthrough can-serve).
  const accountRows = deps.subscriptionTokenWriter
    ? await deps.subscriptionTokenWriter.listSanitizedAccounts().catch(() => ({} as Record<string, unknown[]>))
    : ({} as Record<string, unknown[]>);
  const hasAccounts = (providerId: string): boolean => {
    if (!deps.subscriptionTokenWriter) return false;
    const rows = accountRows[providerId];
    return Array.isArray(rows) && rows.length > 0;
  };
  return [
    ...providers.map((provider) => ({
      key: provider.id,
      label: typeof provider.name === 'string' && provider.name.trim() !== ''
        ? provider.name
        : provider.id,
      target: { kind: 'provider', providerId: provider.id } as GatewayBindingTarget,
    })),
    ...subscriptions
      .filter((entry) => hasAccounts(entry.providerId))
      .map((entry) => ({
        key: `sub:${entry.providerId}`,
        label: entry.displayName?.trim() || entry.providerId,
        target: { kind: 'account-pool', providerId: entry.providerId } as GatewayBindingTarget,
      })),
  ];
}

/**
 * The derived + legacy route aggregate actually being served. `config`
 * overrides the stored load (the PUT /server transaction passes its NEXT
 * config so mapping changes apply atomically).
 */
export async function assembledGatewayBindings(
  deps: UpstreamRoutingDeps,
  config?: OutboundApiServerConfig,
): Promise<GatewayBinding[]> {
  const serverConfig = config ?? (await loadServerConfig(deps.settingsStore));
  const [keys, catalog] = await Promise.all([
    deps.keyDb.outboundApiKeysList(),
    listUpstreamCatalog(deps),
  ]);
  const labels = new Map(catalog.map((entry) => [JSON.stringify(entry.target), entry.label]));
  return assembleGatewayBindings({
    keys: keys.map((row) => ({ id: row.id, upstreamBinding: row.upstreamBinding })),
    allUpstreams: catalog.map((entry) => entry.target),
    mappingsFor: (target) =>
      serverConfig.upstreamModelMappings?.[upstreamMappingKeyOf(target)],
    labelFor: (target) => labels.get(JSON.stringify(target)),
    legacyBindings: serverConfig.bindings ?? [],
  });
}

/** Validate a mapping-table write (D5): sane rows, and `*` required once a
 *  table names more than one source. Returns an error string, or null. */
export function validateUpstreamMappingTable(
  rows: unknown,
): string | null {
  if (!Array.isArray(rows)) return 'mappings must be an array';
  const seen = new Set<string>();
  let nonRoleRows = 0;
  let hasWildcard = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return 'each mapping must be an object';
    const { source, target } = row as { source?: unknown; target?: unknown };
    if (typeof source !== 'string' || source.trim() === '') return 'mapping.source must be a non-empty string';
    if (typeof target !== 'string' || target.trim() === '') return 'mapping.target must be a non-empty string';
    const key = source.trim();
    if (seen.has(key)) return `duplicate mapping source '${key}'`;
    seen.add(key);
    if (key === 'default' || key === 'background') continue;
    nonRoleRows += 1;
    if (key === '*') hasWildcard = true;
  }
  if (nonRoleRows > 1 && !hasWildcard) {
    return 'a table naming more than one model source must include a "*" wildcard row (the unmatched-name fallback)';
  }
  return null;
}

/**
 * P4 (D7): run the one-time legacy→upstream-model migration.
 * - Keys without an `upstreamBinding` get one materialized from their legacy
 *   candidates (empty set ⇒ deliberate explicit-empty);
 * - every legacy binding's model config merges into the upstream mapping
 *   tables (same-source collisions keep the first and are REPORTED);
 * - the legacy `server.bindings` stay stored untouched — a key's
 *   `upstreamBinding: null` (or the bulk rollback) restores legacy serving.
 */
export async function migrateLegacyUpstreamRouting(
  deps: UpstreamRoutingDeps,
): Promise<UpstreamMigrationResult & { applied: boolean }> {
  const [serverConfig, keys] = await Promise.all([
    loadServerConfig(deps.settingsStore),
    deps.keyDb.outboundApiKeysList(),
  ]);
  const result = migrateLegacyBindingsToUpstreams({
    bindings: serverConfig.bindings ?? [],
    keys: keys.map((row) => ({ id: row.id, upstreamBinding: row.upstreamBinding })),
  });
  // The mapping-table conversion runs exactly ONCE (the flag gates it): a
  // re-run would otherwise resurrect legacy-derived rows the operator deleted.
  // Later runs still materialize bindings for newly-seen unmigrated keys.
  const convertTables = serverConfig.upstreamMigrationDone !== true;
  const hasWork = result.keyBindings.length > 0 || (convertTables && Object.keys(result.mappingTables).length > 0);
  if (!hasWork) return { ...result, mappingTables: {}, applied: false };
  for (const entry of result.keyBindings) {
    await deps.keyDb.outboundApiKeysSetUpstreamBinding(entry.keyId, entry.binding);
  }
  let next: OutboundApiServerConfig = { ...serverConfig, upstreamMigrationDone: true };
  if (convertTables) {
    // Mapping tables: merge INTO the existing ones (a hand-edited row wins
    // over the migrated one — first-wins keeps the operator's intent).
    const tables: Record<string, GatewayModelMapping[]> = { ...(result.mappingTables) };
    for (const [key, rows] of Object.entries(serverConfig.upstreamModelMappings ?? {})) {
      const existing = tables[key] ?? [];
      const sources = new Set(existing.map((row) => row.source));
      tables[key] = [...existing, ...rows.filter((row) => !sources.has(row.source))];
    }
    next = {
      ...next,
      upstreamModelMappings: Object.keys(tables).length > 0 ? tables : undefined,
    };
  }
  await saveServerConfig(deps.settingsStore, next);
  return { ...result, applied: true };
}

/**
 * P4 (D7): the wholesale rollback — clear EVERY key's `upstreamBinding` so all
 * keys fall back to the stored legacy routes (which were never removed).
 */
export async function rollbackLegacyUpstreamRouting(
  deps: UpstreamRoutingDeps,
): Promise<{ cleared: number }> {
  const keys = await deps.keyDb.outboundApiKeysList();
  let cleared = 0;
  for (const row of keys) {
    if (!row.upstreamBinding) continue;
    await deps.keyDb.outboundApiKeysSetUpstreamBinding(row.id, null);
    cleared += 1;
  }
  // Re-arm the one-time mapping conversion so a later forward-migration
  // re-runs the table merge under legacy semantics again.
  const serverConfig = await loadServerConfig(deps.settingsStore);
  if (serverConfig.upstreamMigrationDone) {
    await saveServerConfig(deps.settingsStore, { ...serverConfig, upstreamMigrationDone: undefined });
  }
  return { cleared };
}

/** Sanitized rows for storage (normalize drops blanks; validation ran first). */
export function sanitizeUpstreamMappingRows(
  rows: unknown,
): GatewayModelMapping[] {
  if (!Array.isArray(rows)) return [];
  const out: GatewayModelMapping[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { source, target, effort } = row as {
      source?: unknown; target?: unknown; effort?: unknown;
    };
    if (typeof source !== 'string' || typeof target !== 'string') continue;
    const entry: GatewayModelMapping = { source: source.trim(), target: target.trim() };
    if (typeof effort === 'string' && effort.trim() !== '') entry.effort = effort.trim();
    out.push(entry);
  }
  return out;
}
