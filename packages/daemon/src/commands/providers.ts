/**
 * commands/providers.ts — `omnicross providers presets|add|keys|add-key|rm-key`.
 *
 * Derive a daemon provider row from the curated preset catalog
 * (`@omnicross/contracts/provider-presets`, via the `preset-catalog` seam) AND manage a
 * provider row's multi-key pool offline:
 *
 *   providers presets                    → list the mappable presets + excluded
 *   providers add <presetId>             → write one provider row to config.json
 *   providers keys <providerId>          → list a provider's pool (masked)
 *   providers add-key <providerId> --key → append a pool key (auto id)
 *   providers rm-key <providerId> <keyId>→ remove a pool key
 *
 * Mirrors `runKeys`/`runImportCcr`: first positional is the action, the rest
 * parsed by `node:util.parseArgs`, `--config`/`-c` required. The narrowing/
 * exclusion logic lives in the pure `preset-map.ts`; this file only parses argv,
 * reads/writes config.json, and prints. `add`/`add-key`/`rm-key` do NOT
 * hot-reload (offline edit, like `import-ccr`); a running daemon picks the row
 * up on restart or admin write.
 *
 * @module @omnicross/daemon/commands/providers
 */

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { maskProviderApiKey } from '../admin/adminApi';
import { type DaemonApiKeyEntry, loadConfig, saveConfig, setSecretBox } from '../config';
import { getPresetById } from '../preset-catalog';
import { listMappablePresets, mapPresetToProvider } from '../preset-map';

import { resolveSecretBox } from './paths';

/** Run the `providers` subcommand. `argv` is everything after `providers`. */
export async function runProviders(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      key: { type: 'string' },
      id: { type: 'string' },
      'base-url': { type: 'string', short: 'b' },
      label: { type: 'string' },
      weight: { type: 'string' },
      'master-key-file': { type: 'string' },
    },
    allowPositionals: true,
  });
  const configPath = values.config;
  if (!configPath) {
    throw new Error('providers: --config <path> is required');
  }

  // At-rest encryption (secrets design D6): inject the offline `SecretBox` so a
  // `loadConfig` decrypts (mask shows the REAL last4) and any `saveConfig` is
  // encrypt-on-write. `presets` is config-free and is dispatched BEFORE this so
  // it never resolves/auto-generates a master key.
  const action = positionals[0];
  if (action === 'presets') return providersPresets();
  setSecretBox(resolveSecretBox(values['master-key-file']));
  try {
    switch (action) {
      case 'add':
        return providersAdd(configPath, positionals[1], {
          key: values.key,
          id: values.id,
          baseUrl: values['base-url'],
        });
      case 'keys':
        return providersKeys(configPath, positionals[1]);
      case 'add-key':
        return providersAddKey(configPath, positionals[1], {
          key: values.key,
          label: values.label,
          weight: values.weight,
        });
      case 'rm-key':
        return providersRmKey(configPath, positionals[1], positionals[2]);
      default:
        throw new Error(
          `providers: unknown action '${action ?? ''}' (expected presets|add|keys|add-key|rm-key)`,
        );
    }
  } finally {
    setSecretBox(null);
  }
}

/** `providers presets` — list the mappable + excluded presets. */
function providersPresets(): void {
  const { mappable, excluded } = listMappablePresets();
  console.info(`Mappable presets (${mappable.length}):`);
  for (const p of mappable) {
    console.info(`  ${p.id}  ${p.apiFormat}  ${p.baseUrl}  models=${p.models.length}`);
  }
  if (excluded.length > 0) {
    console.info('');
    console.info(`Excluded (${excluded.length}):`);
    for (const e of excluded) {
      console.info(`  ${e.id}  EXCLUDED  ${e.reason}`);
    }
  }
}

/** `providers add <presetId>` — write one preset-derived provider row to config.json. */
function providersAdd(
  configPath: string,
  presetId: string | undefined,
  opts: { key: string | undefined; id: string | undefined; baseUrl: string | undefined },
): void {
  if (!presetId) {
    throw new Error('providers add: a <presetId> is required');
  }
  const preset = getPresetById(presetId);
  if (!preset) {
    const ids = listMappablePresets().mappable.map((p) => p.id).join(', ');
    throw new Error(`providers add: unknown preset '${presetId}'. Available: ${ids}`);
  }
  if (!opts.key) {
    throw new Error(`providers add: --key <key|$ENV_VAR> is required (preset '${presetId}' carries no key)`);
  }

  const result = mapPresetToProvider(preset, {
    key: opts.key,
    id: opts.id,
    baseUrlOverride: opts.baseUrl,
  });
  if ('excluded' in result) {
    throw new Error(`providers add: preset '${presetId}' cannot be mapped — ${result.excluded.reason}`);
  }
  // `missingKey` is already guarded above (key is non-empty here); narrow defensively.
  if ('missingKey' in result) {
    throw new Error(`providers add: --key <key|$ENV_VAR> is required`);
  }

  const { provider } = result;
  const cfg = loadConfig(configPath);
  if (cfg.providers.some((p) => p.id === provider.id)) {
    throw new Error(`providers add: a provider with id '${provider.id}' already exists in ${configPath}`);
  }
  cfg.providers.push(provider);
  saveConfig(configPath, cfg);

  console.info(`Added provider '${provider.id}' (${provider.apiFormat}) → ${configPath}`);
  console.info(`  baseUrl: ${provider.baseUrl}`);
  console.info(`  models:  ${(provider.models ?? []).length}`);
}

// ── Pool key management (key-pool design D8; offline, no hot-reload) ───────────

/**
 * Resolve the effective pool view for a provider row, mirroring the loader's D1
 * synthesis: an explicit `apiKeys[]`, else a single-key 1-key fallback, else [].
 */
function effectivePool(row: {
  id: string;
  apiKey: string;
  apiKeys?: DaemonApiKeyEntry[];
}): DaemonApiKeyEntry[] {
  if (row.apiKeys && row.apiKeys.length > 0) return row.apiKeys;
  if (row.apiKey.length > 0) return [{ id: `${row.id}:default`, apiKey: row.apiKey, weight: 1, enabled: true }];
  return [];
}

/** `providers keys <providerId>` — list the provider's pool (masked). */
function providersKeys(configPath: string, providerId: string | undefined): void {
  if (!providerId) throw new Error('providers keys: a <providerId> is required');
  const cfg = loadConfig(configPath);
  const row = cfg.providers.find((p) => p.id === providerId);
  if (!row) throw new Error(`providers keys: unknown provider '${providerId}'`);
  const pool = effectivePool(row);
  console.info(`Pool for '${providerId}' (${pool.length} key${pool.length === 1 ? '' : 's'}):`);
  for (const k of pool) {
    const enabled = k.enabled !== false ? 'enabled' : 'disabled';
    const weight = typeof k.weight === 'number' ? k.weight : 1;
    console.info(`  ${k.id}  ${k.label ?? k.id}  ${maskProviderApiKey(k.apiKey)}  ${enabled}  weight=${weight}`);
  }
}

/** `providers add-key <providerId> --key <k|$ENV> [--label] [--weight]` — append. */
function providersAddKey(
  configPath: string,
  providerId: string | undefined,
  opts: { key: string | undefined; label: string | undefined; weight: string | undefined },
): void {
  if (!providerId) throw new Error('providers add-key: a <providerId> is required');
  if (!opts.key) throw new Error('providers add-key: --key <key|$ENV_VAR> is required');
  const cfg = loadConfig(configPath);
  const row = cfg.providers.find((p) => p.id === providerId);
  if (!row) throw new Error(`providers add-key: unknown provider '${providerId}'`);

  const entry: DaemonApiKeyEntry = { id: randomUUID(), apiKey: opts.key };
  if (opts.label) entry.label = opts.label;
  if (opts.weight !== undefined) {
    const w = Number(opts.weight);
    if (!Number.isFinite(w)) throw new Error('providers add-key: --weight must be a number');
    entry.weight = w;
  }
  row.apiKeys = [...(row.apiKeys ?? []), entry];
  saveConfig(configPath, cfg);
  console.info(`Added pool key '${entry.id}' to provider '${providerId}' → ${configPath} (not hot-reloaded)`);
}

/** `providers rm-key <providerId> <keyId>` — remove one pool key. */
function providersRmKey(
  configPath: string,
  providerId: string | undefined,
  keyId: string | undefined,
): void {
  if (!providerId) throw new Error('providers rm-key: a <providerId> is required');
  if (!keyId) throw new Error('providers rm-key: a <keyId> is required');
  const cfg = loadConfig(configPath);
  const row = cfg.providers.find((p) => p.id === providerId);
  if (!row) throw new Error(`providers rm-key: unknown provider '${providerId}'`);
  const before = row.apiKeys ?? [];
  const after = before.filter((k) => k.id !== keyId);
  if (after.length === before.length) {
    throw new Error(`providers rm-key: provider '${providerId}' has no pool key '${keyId}'`);
  }
  row.apiKeys = after.length > 0 ? after : undefined;
  saveConfig(configPath, cfg);
  console.info(`Removed pool key '${keyId}' from provider '${providerId}' → ${configPath} (not hot-reloaded)`);
}
