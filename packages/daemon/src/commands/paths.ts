/**
 * commands/paths.ts — shared path derivation + at-rest box resolution for the
 * CLI commands.
 *
 * The named-key store lives next to the config.json by convention (`keys.json`
 * in the same directory), so both `start` and `keys` resolve it the same way.
 *
 * @module @omnicross/daemon/commands/paths
 */

import { dirname, join } from 'node:path';

import { resolveMasterKey, SecretBox } from '../secrets';

/** Resolve the keys.json path that sits alongside a given config.json path. */
export function defaultKeysPath(configPath: string): string {
  return join(dirname(configPath), 'keys.json');
}

/** Resolve the subscription tokens.json path that sits alongside a given
 *  config.json path (convention parity with `defaultKeysPath`). A `--tokens`
 *  CLI flag is deferred to RT3 — drop `tokens.json` next to `config.json`. */
export function defaultTokensPath(configPath: string): string {
  return join(dirname(configPath), 'tokens.json');
}

/** Resolve the pricing.json path that sits alongside a given config.json path
 *  (convention parity with `defaultKeysPath`). */
export function defaultPricingPath(configPath: string): string {
  return join(dirname(configPath), 'pricing.json');
}

/** Resolve the append-only usage-events.jsonl path that sits alongside a given
 *  config.json path (convention parity with `defaultKeysPath`). */
export function defaultUsageEventsPath(configPath: string): string {
  return join(dirname(configPath), 'usage-events.jsonl');
}

/** Resolve the `audit/` directory (date-rotated audit jsonl files) that sits
 *  alongside a given config.json path (request-audit-log, design D4). */
export function defaultAuditDir(configPath: string): string {
  return join(dirname(configPath), 'audit');
}

/**
 * Build a `SecretBox` for an OFFLINE CLI write (secrets design D3/D6) with a
 * LAZY master-key resolver (env → keyfile → auto-gen 0600). The key is only
 * resolved (and a keyfile only auto-generated) when the box first encrypts or
 * decrypts a value — so a command that touches only plaintext/`$ENV` never
 * materializes a keyfile. Offline commands call this + `setSecretBox(box)` so
 * anything they persist via `saveConfig` is encrypt-on-write.
 */
export function resolveSecretBox(masterKeyFilePath?: string): SecretBox {
  return new SecretBox(() => resolveMasterKey({ keyFilePath: masterKeyFilePath }));
}
