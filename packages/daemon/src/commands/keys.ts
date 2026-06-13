/**
 * commands/keys.ts — `omnicross keys add|list|revoke`.
 *
 * Named outbound API-key management over the file-backed `JsonOutboundKeyDb`.
 * Key generation + hashing is core's `createNamedKey` (the daemon never mints or
 * hashes secrets itself).
 *
 *   keys add <name>    → print the one-time plaintext (shown exactly once)
 *   keys list          → print stored keys WITHOUT secrets
 *   keys revoke <id>   → revoke a key by id
 *
 * @module @omnicross/daemon/commands/keys
 */

import { parseArgs } from 'node:util';

import { createNamedKey } from '@omnicross/core/outbound-api';

import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';

import { defaultKeysPath } from './paths';

/** Run the `keys` subcommand. `argv` is everything after `keys`. */
export async function runKeys(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { config: { type: 'string', short: 'c' } },
    allowPositionals: true,
  });
  const configPath = values.config;
  if (!configPath) {
    throw new Error('keys: --config <path> is required');
  }
  const db = new JsonOutboundKeyDb(defaultKeysPath(configPath));

  const action = positionals[0];
  switch (action) {
    case 'add':
      return keysAdd(db, positionals[1]);
    case 'list':
      return keysList(db);
    case 'revoke':
      return keysRevoke(db, positionals[1]);
    default:
      throw new Error(`keys: unknown action '${action ?? ''}' (expected add|list|revoke)`);
  }
}

async function keysAdd(db: JsonOutboundKeyDb, name: string | undefined): Promise<void> {
  if (!name) throw new Error('keys add: a <name> is required');
  const created = await createNamedKey(db, name);
  console.info(`Created key '${created.name}' (id: ${created.id}).`);
  console.info('');
  console.info(`  ${created.plaintextOnce}`);
  console.info('');
  console.info('This is the ONLY time the full key is shown — store it now.');
}

async function keysList(db: JsonOutboundKeyDb): Promise<void> {
  const rows = await db.outboundApiKeysList();
  if (rows.length === 0) {
    console.info('No keys.');
    return;
  }
  for (const r of rows) {
    const state = r.revokedAt !== null ? 'revoked' : r.enabled ? 'enabled' : 'disabled';
    const last = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : 'never';
    console.info(
      `${r.id}  ${r.keyPrefix}…  ${state}  name=${r.name}  ` +
        `created=${new Date(r.createdAt).toISOString()}  lastUsed=${last}`,
    );
  }
}

async function keysRevoke(db: JsonOutboundKeyDb, id: string | undefined): Promise<void> {
  if (!id) throw new Error('keys revoke: an <id> is required');
  const ok = await db.outboundApiKeysRevoke(id);
  console.info(ok ? `Revoked key '${id}'.` : `No active key with id '${id}'.`);
}
