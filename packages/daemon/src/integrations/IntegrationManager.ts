import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createIntegrationKey, type OutboundKeyDb } from '@omnicross/core';

import { atomicWrite, IntegrationStateStore } from './IntegrationStateStore';
import {
  renderClaudeSettings,
  renderCodexAuth,
  renderCodexConfig,
  restoreClaudeBase,
  restoreCodexBase,
} from './configAdapters';
import type {
  IntegrationChangePlan,
  IntegrationClientId,
  IntegrationClientStatus,
  IntegrationGatewayKeyRecord,
  IntegrationInstallRecord,
  IntegrationManagedFileRecord,
  IntegrationState,
} from './types';

export class IntegrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConflictError';
  }
}

export interface IntegrationManagerOptions {
  configPath: string;
  gatewayBaseUrl: string;
  keyDb: OutboundKeyDb;
  stateStore: IntegrationStateStore;
  homeDir?: string;
}

/** Coordinates a least-privilege gateway key with reversible native CLI config edits. */
export class IntegrationManager {
  private readonly homeDir: string;

  constructor(private readonly options: IntegrationManagerOptions) {
    assertLoopbackGatewayUrl(options.gatewayBaseUrl);
    this.homeDir = options.homeDir ?? homedir();
  }

  async listStatus(): Promise<IntegrationClientStatus[]> {
    const state = this.options.stateStore.load();
    const keyUsable = await this.isKeyUsable(state);
    return (['codex', 'claude'] as const).map((client) => this.statusFor(client, state, keyUsable));
  }

  async plan(
    client: IntegrationClientId,
    configPath = this.defaultConfigPath(client),
  ): Promise<IntegrationChangePlan> {
    const state = this.options.stateStore.load();
    const record = state.clients[client];
    const target = record?.configPath ?? resolve(configPath);
    const status = this.statusFor(client, state, await this.isKeyUsable(state));
    const changes = client === 'codex'
      ? [
          'model_provider',
          'preferred_auth_method',
          'model_providers.omnicross',
          'auth.json.auth_mode',
          'auth.json.OPENAI_API_KEY',
        ]
      : ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_AUTH_TOKEN', 'env.ANTHROPIC_API_KEY'];
    if (!record) return { client, configPath: target, action: 'install', canApply: true, changes, warnings: [] };
    if (status.status === 'enabled') {
      return { client, configPath: target, action: 'none', canApply: true, changes: [], warnings: [] };
    }
    return {
      client,
      configPath: target,
      action: 'repair',
      canApply: true,
      changes,
      warnings: ['Configuration changed after installation; repair preserves unrelated current settings.'],
    };
  }

  async install(client: IntegrationClientId, configPath = this.defaultConfigPath(client)):
    Promise<IntegrationClientStatus> {
    const target = resolve(configPath);
    const state = this.options.stateStore.load();
    const existingRecord = state.clients[client];
    if (existingRecord) {
      const status = this.statusFor(client, state, await this.isKeyUsable(state));
      if (status.status === 'enabled') return status;
      throw new IntegrationConflictError(
        `${client} integration configuration has drifted; restore or remove it before reinstalling`,
      );
    }

    const key = await this.ensureGatewayKey(state);
    const original = readOptional(target);
    const originalContent = original ?? '';
    const installed = this.renderInstalled(client, originalContent, key.secret);
    const credentialPath = client === 'codex' ? this.codexAuthPathForConfig(target) : undefined;
    const originalCredential = credentialPath ? readOptional(credentialPath) : null;
    const installedCredential = credentialPath ? renderCodexAuth(key.secret) : undefined;

    const record: IntegrationInstallRecord = {
      client,
      configPath: target,
      originalExisted: original !== null,
      originalContent,
      originalHash: sha256(originalContent),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
      credentialFile: credentialPath && installedCredential
        ? managedFileRecord(credentialPath, originalCredential, installedCredential)
        : undefined,
    };

    const prior = state.clients[client];
    state.clients[client] = record;
    this.options.stateStore.save(state);
    try {
      applyFileChangesWithRollback([
        { path: target, content: installed },
        ...(credentialPath && installedCredential
          ? [{ path: credentialPath, content: installedCredential }]
          : []),
      ]);
    } catch (error) {
      if (prior) state.clients[client] = prior;
      else delete state.clients[client];
      this.options.stateStore.save(state);
      throw error;
    }
    return this.statusFor(client, state, true);
  }

  async repair(client: IntegrationClientId): Promise<IntegrationClientStatus> {
    const state = this.options.stateStore.load();
    const record = state.clients[client];
    if (!record) return this.install(client);
    const previouslyInstalledSecret = state.gatewayKey?.secret;
    const currentFile = readOptional(record.configPath);
    // Claude keeps the local gateway key directly in settings.json. If state
    // was lost, the old token cannot be distinguished from a user edit, so
    // preserving it as the next restore snapshot would reintroduce a
    // credential after a later remove.
    if (client === 'claude' && currentFile !== null && !previouslyInstalledSecret) {
      throw new IntegrationConflictError(
        'Claude integration key state is missing; refusing to repair an ambiguous settings file',
      );
    }
    const key = await this.ensureGatewayKey(state);
    const current = currentFile ?? record.originalContent;
    const base = client === 'codex'
      ? restoreCodexBase(current, record.originalContent)
      : restoreClaudeBase(
          current,
          record.originalContent,
          record.gatewayBaseUrl,
          previouslyInstalledSecret ?? key.secret,
        );
    const installed = this.renderInstalled(client, base, key.secret);
    const credentialPath = client === 'codex'
      ? record.credentialFile?.path ?? this.codexAuthPathForConfig(record.configPath)
      : undefined;
    const currentCredential = credentialPath ? readOptional(credentialPath) : null;
    const originalCredential = record.credentialFile
      ? originalSnapshotForRepair(record.credentialFile, currentCredential)
      : currentCredential;
    const installedCredential = credentialPath ? renderCodexAuth(key.secret) : undefined;
    const prior = {
      ...record,
      credentialFile: record.credentialFile ? { ...record.credentialFile } : undefined,
    };
    Object.assign(record, {
      originalExisted: currentFile !== null || record.originalExisted,
      originalContent: base,
      originalHash: sha256(base),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
      credentialFile: credentialPath && installedCredential
        ? managedFileRecord(credentialPath, originalCredential, installedCredential)
        : undefined,
    });
    this.options.stateStore.save(state);
    try {
      applyFileChangesWithRollback([
        { path: record.configPath, content: installed },
        ...(credentialPath && installedCredential
          ? [{ path: credentialPath, content: installedCredential }]
          : []),
      ]);
    } catch (error) {
      state.clients[client] = prior;
      this.options.stateStore.save(state);
      throw error;
    }
    return this.statusFor(client, state, true);
  }

  async remove(client: IntegrationClientId): Promise<IntegrationClientStatus> {
    const state = this.options.stateStore.load();
    const record = state.clients[client];
    if (!record) return this.statusFor(client, state, await this.isKeyUsable(state));

    const files = [primaryManagedFile(record), ...(record.credentialFile ? [record.credentialFile] : [])];
    const currentFiles = files.map((file) => ({ file, current: readOptional(file.path) }));
    const dispositions = currentFiles.map(({ file, current }) => managedFileDisposition(file, current));
    if (dispositions.some((disposition) => disposition !== 'installed' && disposition !== 'restored')) {
      throw new IntegrationConflictError(
        `${client} configuration changed after Omnicross installed it; refusing to overwrite user edits`,
      );
    }
    const changes = currentFiles.flatMap(({ file }, index) => dispositions[index] === 'installed'
      ? [{ path: file.path, content: file.originalExisted ? file.originalContent : null }]
      : []);
    applyFileChangesWithRollback(changes);
    delete state.clients[client];
    this.options.stateStore.save(state);
    return this.statusFor(client, state, await this.isKeyUsable(state));
  }

  async rotateGatewayKey(): Promise<{ keyId: string }> {
    const state = this.options.stateStore.load();
    const previousGatewayKey = state.gatewayKey;
    const oldKeyId = state.gatewayKey?.id;
    const claude = state.clients.claude;
    const codex = state.clients.codex;
    let nextClaude: string | undefined;
    let nextCodexAuth: string | undefined;
    if (claude) {
      const current = readOptional(claude.configPath);
      if (current === null || sha256(current) !== claude.installedHash) {
        throw new IntegrationConflictError('Claude configuration drift must be resolved before key rotation');
      }
    }
    if (codex) {
      const current = readOptional(codex.configPath);
      if (current === null || sha256(current) !== codex.installedHash) {
        throw new IntegrationConflictError('Codex configuration drift must be resolved before key rotation');
      }
      if (!codex.credentialFile) {
        throw new IntegrationConflictError('Codex integration must be repaired before key rotation');
      }
      const currentAuth = readOptional(codex.credentialFile.path);
      if (currentAuth === null || sha256(currentAuth) !== codex.credentialFile.installedHash) {
        throw new IntegrationConflictError('Codex credential drift must be resolved before key rotation');
      }
    }

    const created = await createIntegrationKey(this.options.keyDb, 'Omnicross native CLI integration');
    const nextGatewayKey: IntegrationGatewayKeyRecord = {
      id: created.id,
      secret: created.plaintextOnce,
      createdAt: created.createdAt,
    };
    state.gatewayKey = nextGatewayKey;
    const previousClaudeHash = claude?.installedHash;
    const previousCodexAuthHash = codex?.credentialFile?.installedHash;
    if (claude) {
      const current = readOptional(claude.configPath) ?? '{}';
      nextClaude = renderClaudeSettings(current, this.options.gatewayBaseUrl, created.plaintextOnce);
      claude.installedHash = sha256(nextClaude);
    }
    if (codex?.credentialFile) {
      nextCodexAuth = renderCodexAuth(created.plaintextOnce);
      codex.credentialFile.installedHash = sha256(nextCodexAuth);
    }
    try {
      this.options.stateStore.save(state);
      applyFileChangesWithRollback([
        ...(codex?.credentialFile && nextCodexAuth !== undefined
          ? [{ path: codex.credentialFile.path, content: nextCodexAuth }]
          : []),
        ...(claude && nextClaude !== undefined
          ? [{ path: claude.configPath, content: nextClaude }]
          : []),
      ]);
    } catch (error) {
      state.gatewayKey = previousGatewayKey;
      if (claude && previousClaudeHash !== undefined) claude.installedHash = previousClaudeHash;
      if (codex?.credentialFile && previousCodexAuthHash !== undefined) {
        codex.credentialFile.installedHash = previousCodexAuthHash;
      }
      try {
        this.options.stateStore.save(state);
      } finally {
        await this.options.keyDb.outboundApiKeysRevoke(created.id);
      }
      throw error;
    }
    if (oldKeyId && oldKeyId !== created.id) await this.options.keyDb.outboundApiKeysRevoke(oldKeyId);
    return { keyId: created.id };
  }

  async getGatewayToken(): Promise<string> {
    const state = this.options.stateStore.load();
    if (!state.gatewayKey || !(await this.isKeyUsable(state))) {
      throw new Error('Omnicross integration key is missing or revoked; reinstall the CLI integration');
    }
    return state.gatewayKey.secret;
  }

  private async ensureGatewayKey(state: IntegrationState): Promise<IntegrationGatewayKeyRecord> {
    if (state.gatewayKey && await this.isKeyUsable(state)) return state.gatewayKey;
    const created = await createIntegrationKey(this.options.keyDb, 'Omnicross native CLI integration');
    const previousGatewayKey = state.gatewayKey;
    const nextGatewayKey: IntegrationGatewayKeyRecord = {
      id: created.id,
      secret: created.plaintextOnce,
      createdAt: created.createdAt,
    };
    state.gatewayKey = nextGatewayKey;
    try {
      this.options.stateStore.save(state);
      return nextGatewayKey;
    } catch (error) {
      state.gatewayKey = previousGatewayKey;
      try {
        await this.options.keyDb.outboundApiKeysRevoke(created.id);
      } catch {
        // Preserve the original state-store error. A failed revocation is still
        // visible in the key store for manual cleanup rather than being hidden.
      }
      throw error;
    }
  }

  private async isKeyUsable(state: IntegrationState): Promise<boolean> {
    if (!state.gatewayKey) return false;
    const rows = await this.options.keyDb.outboundApiKeysList();
    return rows.some((row) => row.id === state.gatewayKey?.id && row.enabled && row.revokedAt === null &&
      row.kind === 'integration');
  }

  private statusFor(
    client: IntegrationClientId,
    state: IntegrationState,
    keyUsable: boolean,
  ): IntegrationClientStatus {
    const record = state.clients[client];
    if (!record) return { client, status: 'not-installed', configPath: this.defaultConfigPath(client) };
    const current = readOptional(record.configPath);
    if (current === null) {
      return { client, status: 'configuration-missing', configPath: record.configPath,
        installedAt: record.installedAt, gatewayBaseUrl: record.gatewayBaseUrl };
    }
    if (sha256(current) !== record.installedHash) {
      return { client, status: 'configuration-drift', configPath: record.configPath,
        installedAt: record.installedAt, gatewayBaseUrl: record.gatewayBaseUrl };
    }
    if (client === 'codex') {
      if (!record.credentialFile) {
        return {
          client,
          status: 'configuration-drift',
          configPath: record.configPath,
          installedAt: record.installedAt,
          gatewayBaseUrl: record.gatewayBaseUrl,
          message: 'Codex integration uses a legacy authentication layout and must be repaired.',
        };
      }
      const credential = readOptional(record.credentialFile.path);
      if (credential === null) {
        return {
          client,
          status: 'configuration-missing',
          configPath: record.configPath,
          installedAt: record.installedAt,
          gatewayBaseUrl: record.gatewayBaseUrl,
          message: 'Codex auth.json is missing.',
        };
      }
      if (sha256(credential) !== record.credentialFile.installedHash) {
        return {
          client,
          status: 'configuration-drift',
          configPath: record.configPath,
          installedAt: record.installedAt,
          gatewayBaseUrl: record.gatewayBaseUrl,
          message: 'Codex auth.json changed after installation.',
        };
      }
    }
    return {
      client,
      status: keyUsable ? 'enabled' : 'key-missing',
      configPath: record.configPath,
      installedAt: record.installedAt,
      gatewayBaseUrl: record.gatewayBaseUrl,
    };
  }

  private defaultConfigPath(client: IntegrationClientId): string {
    return client === 'codex'
      ? join(this.homeDir, '.codex', 'config.toml')
      : join(this.homeDir, '.claude', 'settings.json');
  }

  private codexAuthPathForConfig(configPath: string): string {
    return join(dirname(configPath), 'auth.json');
  }

  private renderInstalled(client: IntegrationClientId, base: string, secret: string): string {
    if (client === 'claude') {
      return renderClaudeSettings(base, this.options.gatewayBaseUrl, secret);
    }
    return renderCodexConfig({
      existing: base,
      gatewayBaseUrl: this.options.gatewayBaseUrl,
    });
  }
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function managedFileRecord(
  path: string,
  original: string | null,
  installed: string,
): IntegrationManagedFileRecord {
  const originalContent = original ?? '';
  return {
    path,
    originalExisted: original !== null,
    originalContent,
    originalHash: sha256(originalContent),
    installedHash: sha256(installed),
  };
}

function primaryManagedFile(record: IntegrationInstallRecord): IntegrationManagedFileRecord {
  return {
    path: record.configPath,
    originalExisted: record.originalExisted,
    originalContent: record.originalContent,
    originalHash: record.originalHash,
    installedHash: record.installedHash,
  };
}

type ManagedFileDisposition = 'installed' | 'restored' | 'missing' | 'drift';

function managedFileDisposition(
  record: IntegrationManagedFileRecord,
  current: string | null,
): ManagedFileDisposition {
  if (current !== null && sha256(current) === record.installedHash) return 'installed';
  const matchesOriginalExistence = record.originalExisted ? current !== null : current === null;
  if (matchesOriginalExistence && sha256(current ?? '') === record.originalHash) return 'restored';
  return current === null ? 'missing' : 'drift';
}

function originalSnapshotForRepair(
  record: IntegrationManagedFileRecord,
  current: string | null,
): string | null {
  const disposition = managedFileDisposition(record, current);
  if (disposition === 'installed' || disposition === 'restored') {
    return record.originalExisted ? record.originalContent : null;
  }
  return current;
}

interface FileChange {
  path: string;
  content: string | null;
}

/** Apply an ordered multi-file update and restore every touched file on failure. */
function applyFileChangesWithRollback(changes: FileChange[]): void {
  if (changes.length === 0) return;
  const snapshots = changes.map((change) => ({ path: change.path, content: readOptional(change.path) }));
  try {
    for (const change of changes) writeOptional(change.path, change.content);
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try { writeOptional(snapshot.path, snapshot.content); }
      catch { rollbackFailures.push(snapshot.path); }
    }
    if (rollbackFailures.length > 0) {
      throw new IntegrationConflictError(
        `CLI integration update failed and rollback could not restore: ${rollbackFailures.join(', ')}`,
      );
    }
    throw error;
  }
}

function writeOptional(path: string, content: string | null): void {
  if (content !== null) {
    atomicWrite(path, content);
    return;
  }
  if (existsSync(path)) unlinkSync(path);
}

function assertLoopbackGatewayUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('gatewayBaseUrl must be a valid loopback URL'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const literalLoopback = host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    url.protocol !== 'http:' || !literalLoopback || url.username || url.password ||
    url.search || url.hash
  ) {
    throw new Error('native CLI integrations require an unauthenticated literal HTTP loopback gateway URL');
  }
}
