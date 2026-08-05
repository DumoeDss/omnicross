import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { SecretBox } from '../secrets';

import type { IntegrationClientId, IntegrationInstallRecord, IntegrationState } from './types';

const EMPTY_STATE: IntegrationState = { version: 1, clients: {} };

/** Encrypted, Omnicross-owned state for reversible native CLI configuration. */
export class IntegrationStateStore {
  constructor(
    readonly path: string,
    private readonly box: SecretBox,
  ) {}

  load(): IntegrationState {
    if (!existsSync(this.path)) return { ...EMPTY_STATE, clients: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch {
      throw new Error(`integration state '${this.path}' is not valid JSON`);
    }
    if (!isState(raw)) {
      throw new Error(`integration state '${this.path}' has an unsupported shape`);
    }
    return {
      version: 1,
      gatewayKey: raw.gatewayKey
        ? { ...raw.gatewayKey, secret: this.box.decryptMaybe(raw.gatewayKey.secret) }
        : undefined,
      clients: decryptClients(raw.clients, this.box),
    };
  }

  save(state: IntegrationState): void {
    const encrypted: IntegrationState = {
      version: 1,
      gatewayKey: state.gatewayKey
        ? { ...state.gatewayKey, secret: this.box.encrypt(state.gatewayKey.secret) }
        : undefined,
      clients: encryptClients(state.clients, this.box),
    };
    atomicWrite(this.path, JSON.stringify(encrypted, null, 2) + '\n');
  }
}

function transformClients(
  clients: IntegrationState['clients'],
  transform: (value: string) => string,
): IntegrationState['clients'] {
  const out: IntegrationState['clients'] = {};
  for (const client of ['codex', 'claude'] as const) {
    const row = clients[client];
    if (row) {
      out[client] = {
        ...row,
        originalContent: transform(row.originalContent),
        credentialFile: row.credentialFile
          ? { ...row.credentialFile, originalContent: transform(row.credentialFile.originalContent) }
          : undefined,
      };
    }
  }
  return out;
}

function decryptClients(
  clients: IntegrationState['clients'],
  box: SecretBox,
): IntegrationState['clients'] {
  return transformClients(clients, (value) => box.decryptMaybe(value));
}

function encryptClients(
  clients: IntegrationState['clients'],
  box: SecretBox,
): IntegrationState['clients'] {
  // Config snapshots are arbitrary text, not SecretBox's `$ENV` vocabulary.
  // Encrypt unconditionally so a file beginning with `$` can never bypass at-rest protection.
  return transformClients(clients, (value) => box.encrypt(value));
}

function isState(value: unknown): value is IntegrationState {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !row.clients || typeof row.clients !== 'object') return false;
  if (row.gatewayKey !== undefined) {
    const key = row.gatewayKey as Record<string, unknown>;
    if (!key || typeof key !== 'object' || typeof key.id !== 'string' ||
      typeof key.secret !== 'string' || typeof key.createdAt !== 'number') return false;
  }
  for (const client of ['codex', 'claude'] as IntegrationClientId[]) {
    const candidate = (row.clients as Record<string, unknown>)[client];
    if (candidate === undefined) continue;
    if (!isInstallRecord(candidate, client)) return false;
  }
  return true;
}

function isInstallRecord(value: unknown, client: IntegrationClientId): value is IntegrationInstallRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.client === client && typeof row.configPath === 'string' &&
    typeof row.originalExisted === 'boolean' && typeof row.originalContent === 'string' &&
    typeof row.originalHash === 'string' && typeof row.installedHash === 'string' &&
    typeof row.installedAt === 'number' && typeof row.gatewayBaseUrl === 'string' &&
    (row.credentialFile === undefined || isManagedFileRecord(row.credentialFile));
}

function isManagedFileRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.path === 'string' && typeof row.originalExisted === 'boolean' &&
    typeof row.originalContent === 'string' && typeof row.originalHash === 'string' &&
    typeof row.installedHash === 'string';
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    throw error;
  } finally {
    if (existsSync(path)) {
      try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
    }
  }
}
