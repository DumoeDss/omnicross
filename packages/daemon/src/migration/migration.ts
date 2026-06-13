/**
 * migration.ts — the export gather + import apply logic for the passphrase pack
 * (app-parity child 6, design D2/D3/D5).
 *
 * EXPORT (`gatherExport`): read the FULL local state DECRYPTED in-memory — every
 * provider row (scalars / modelConfigs / single apiKey / pool apiKeys /
 * transformer) via `loadConfig` (the at-rest box decrypts on read) AND the
 * subscription tokens via `credentialStore.getFullConfig()` (also decrypted) —
 * serialize to ONE bundle JSON, and `sealPack` it under the passphrase-derived
 * key. The caller returns ONLY the opaque pack; the decrypted bundle + the
 * passphrase live only in local variables and are never logged.
 *
 * IMPORT (`applyImport`): `openPack` decrypts + authenticates (a wrong passphrase
 * or a tampered pack fails the GCM auth-tag BEFORE any write — atomic). Every
 * provider is re-validated through `parseProviderInput` and every token block
 * through `validateTokenBody` (deny-by-default — a malicious blob cannot inject
 * unknown fields or escape the allowlist). Validation collects ALL rows BEFORE
 * applying, so a structurally invalid pack does not leave a half-applied state.
 * Apply merges by provider id (additive default): a new id is added; a colliding
 * id is skipped (or overwritten with `mode:'overwrite'`). Writes go through the
 * EXISTING paths (`saveConfig` re-encrypts at-rest under the LOCAL box +
 * `writeProviderTokens`/`appendProviderAccount`), so imported secrets land
 * `enc:`-encrypted under the TARGET machine's key — the passphrase key is used
 * ONLY for transport.
 *
 * SECRET SPINE: the export RESPONSE is the opaque pack ONLY; the import RESPONSE
 * is status-only counts. No decrypted secret + no passphrase ever reaches a
 * response body or a log here.
 *
 * @module @omnicross/daemon/migration/migration
 */

import type { AccountTokensConfig } from '@omnicross/contracts/account-tokens-types';
import type { SubscriptionProviderId } from '@omnicross/contracts/subscription-types';

import { type DaemonConfig, type DaemonProviderConfig, loadConfig, saveConfig } from '../config';
import { validateTokenBody } from '../admin/accountsWrite';
import type { SubscriptionAccountAppender } from '../admin/accountsOAuth';
import { DAEMON_PROVIDER_KEYS, type DaemonProvider } from '../ports/account-multi';
import type { SubscriptionTokenBlock } from '../ports/JsonSubscriptionCredentialStore';

import { openPack, sealPack } from './packCodec';

/** The current bundle format version (independent of the pack envelope version). */
export const BUNDLE_VERSION = 1;

/** Merge mode for import: additive-skip (default) or overwrite colliding ids. */
export type ImportMode = 'merge' | 'overwrite';

/** The decrypted bundle serialized into the pack (NEVER returned to a client). */
interface MigrationBundle {
  v: number;
  providers: DaemonProviderConfig[];
  tokens: AccountTokensConfig;
}

/** The status-only import counts (the import response — never a secret). */
export interface ImportCounts {
  /** Providers imported (each carries its BYO single `apiKey`). */
  providerKeys: number;
  /** Total pool keys (`apiKeys[]`) across imported providers. */
  poolKeys: number;
  /** Subscription token sets (accounts) imported. */
  tokenSets: number;
  /** Pool keys skipped because the key id already existed on a merged provider. */
  duplicates: number;
  /** Provider ids skipped because they already existed (additive-merge default). */
  skipped: string[];
}

/**
 * The credential-store surface the migration paths need: the full DECRYPTED read
 * (export) + the multi-account append (import re-encrypts at-rest). One shape so
 * `ExportDeps` + `ImportDeps` can be unified into `MigrationDeps` without a
 * `credentialStore` type conflict.
 */
export interface MigrationCredentialStore extends SubscriptionAccountAppender {
  getFullConfig(): Promise<AccountTokensConfig>;
}

/** A live provider catalog reloader (so an import hot-reloads). */
export interface ConfigReloader {
  reload(cfg: DaemonConfig): void;
}

/** The deps the export gather needs. */
export interface ExportDeps {
  readonly configPath: string;
  readonly credentialStore: MigrationCredentialStore;
}

/** The deps the import apply needs. */
export interface ImportDeps {
  readonly configPath: string;
  readonly llmConfig: ConfigReloader;
  readonly credentialStore: MigrationCredentialStore;
}

/**
 * Gather the full DECRYPTED state into a bundle and seal it under the passphrase.
 * Excludes `admin` (admin.token is a local-access secret, not portable
 * provider/account state — design OQ2). Returns ONLY the opaque pack string.
 */
export async function gatherExport(deps: ExportDeps, passphrase: string): Promise<string> {
  // `loadConfig` decrypts the at-rest provider secrets in-memory (the module box
  // is set during boot). The bundle carries the DECRYPTED rows so the pack is
  // self-contained on the target machine.
  const cfg = loadConfig(deps.configPath);
  const tokens = await deps.credentialStore.getFullConfig();
  const bundle: MigrationBundle = {
    v: BUNDLE_VERSION,
    providers: cfg.providers,
    tokens,
  };
  // Seal — the bundle JSON + passphrase live only here and are dropped after.
  return sealPack(JSON.stringify(bundle), passphrase);
}

/** The four subscription providers, in a stable order, for token import. */
const SUBSCRIPTION_PROVIDERS: readonly DaemonProvider[] = ['claude', 'codex', 'gemini', 'opencodego'];

/** Collect every account's raw token block for one provider from the bundle.
 *  Prefers the multi-account `<provider>Accounts[]` array; falls back to the
 *  top-level mirror block when no accounts array is present (legacy single-slot). */
function collectProviderTokenBlocks(
  tokens: AccountTokensConfig,
  provider: DaemonProvider,
): Record<string, unknown>[] {
  const keys = DAEMON_PROVIDER_KEYS[provider];
  const bag = tokens as unknown as Record<string, unknown>;
  const accounts = bag[keys.accounts as string];
  if (Array.isArray(accounts)) {
    const blocks: Record<string, unknown>[] = [];
    for (const entry of accounts) {
      if (entry && typeof entry === 'object' && 'tokens' in entry) {
        const tk = (entry as { tokens?: unknown }).tokens;
        if (tk && typeof tk === 'object' && !Array.isArray(tk)) {
          blocks.push(tk as Record<string, unknown>);
        }
      }
    }
    if (blocks.length > 0) return blocks;
  }
  const mirror = bag[keys.block as string];
  if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
    return [mirror as Record<string, unknown>];
  }
  return [];
}

/**
 * Open + validate + apply a pack (deny-by-default, atomic, merge-by-provider).
 * Validation collects ALL provider rows + token blocks BEFORE any write, so a
 * structurally invalid pack is a hard reject with NO partial write. `parse*`
 * functions are injected so the migration module reuses the SAME write gateways
 * the admin router uses (no duplicate allowlist).
 */
export async function applyImport(
  packString: string,
  passphrase: string,
  mode: ImportMode,
  deps: ImportDeps,
  parseProviderInput: (
    body: Record<string, unknown>,
    existing: DaemonProviderConfig | undefined,
  ) => DaemonProviderConfig | null,
): Promise<ImportCounts> {
  // openPack throws on a wrong passphrase / tampered pack (GCM auth-tag) BEFORE
  // any write is attempted — atomic on a decrypt failure.
  const bundleJson = openPack(packString, passphrase);
  let bundle: MigrationBundle;
  try {
    const parsed = JSON.parse(bundleJson) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    bundle = parsed as MigrationBundle;
  } catch {
    // A decrypted-but-unparseable bundle is a hard reject (NO write).
    throw new Error('migration pack contents are unreadable');
  }
  const rawProviders = Array.isArray(bundle.providers) ? bundle.providers : [];
  const rawTokens =
    bundle.tokens && typeof bundle.tokens === 'object' ? bundle.tokens : ({ updatedAt: '' } as AccountTokensConfig);

  // ── VALIDATE EVERYTHING FIRST (deny-by-default, collect; no write yet) ───────
  // Provider rows through the SAME write gateway the admin router uses. A
  // structurally-invalid row aborts the WHOLE import (atomic — design OQ3).
  const validatedProviders: DaemonProviderConfig[] = [];
  for (const raw of rawProviders) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('migration pack has an invalid provider row');
    }
    const validated = parseProviderInput(raw as unknown as Record<string, unknown>, undefined);
    if (!validated) {
      throw new Error('migration pack has an invalid provider row');
    }
    validatedProviders.push(validated);
  }
  // Token blocks through `validateTokenBody` (deny-by-default). Collect per
  // provider. A malformed block aborts the whole import (atomic).
  const validatedTokens: { provider: SubscriptionProviderId; block: SubscriptionTokenBlock }[] = [];
  for (const provider of SUBSCRIPTION_PROVIDERS) {
    const blocks = collectProviderTokenBlocks(rawTokens, provider);
    for (const block of blocks) {
      const valid = validateTokenBody(provider, block);
      if (!valid) {
        throw new Error(`migration pack has an invalid token block for '${provider}'`);
      }
      validatedTokens.push({ provider, block: valid });
    }
  }

  // ── APPLY (merge-by-provider additive; writes re-encrypt at-rest) ────────────
  // Single config read → merge → ONE saveConfig (atomic config write). Existing
  // ids are skipped by default (the local config is preserved); `overwrite`
  // replaces a matching id. Pool-key id collisions within a merged provider are
  // counted as duplicates (never silently doubling a key id).
  const cfg = loadConfig(deps.configPath);
  const counts: ImportCounts = {
    providerKeys: 0,
    poolKeys: 0,
    tokenSets: 0,
    duplicates: 0,
    skipped: [],
  };
  for (const incoming of validatedProviders) {
    const idx = cfg.providers.findIndex((p) => p.id === incoming.id);
    if (idx >= 0 && mode !== 'overwrite') {
      counts.skipped.push(incoming.id);
      continue;
    }
    if (idx >= 0) {
      cfg.providers[idx] = incoming;
    } else {
      cfg.providers.push(incoming);
    }
    counts.providerKeys += 1;
    if (incoming.apiKeys) counts.poolKeys += incoming.apiKeys.length;
  }
  // Persist the merged config (re-encrypts at-rest under the LOCAL box) + reload.
  saveConfig(deps.configPath, cfg);
  deps.llmConfig.reload(cfg);

  // Token sets: append each validated account (multi-account append +
  // re-encrypt at-rest through the store's `persist`). Append (not overwrite) is
  // the non-destructive merge — importing accounts adds rather than clobbers.
  for (const { provider, block } of validatedTokens) {
    await deps.credentialStore.appendProviderAccount(provider, block);
    counts.tokenSets += 1;
  }

  return counts;
}
