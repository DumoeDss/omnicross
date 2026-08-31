import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createIntegrationKey,
  effectiveOutboundPermissions,
  type OutboundKeyDb,
  type OutboundKeyDbRow,
  type OutboundPermission,
} from '@omnicross/core';

import { currentProcessCodexAuthHelper, type CodexAuthHelperConfig } from './codexAuthHelper';
import { atomicWrite, IntegrationStateStore } from './IntegrationStateStore';
import {
  renderClaudeSettings,
  renderCodexConfig,
  restoreClaudeBase,
  restoreCodexBase,
} from './configAdapters';
import type {
  IntegrationChangePlan,
  IntegrationClientId,
  IntegrationClientStatus,
  IntegrationKeyBinding,
  IntegrationKeyBindingStatus,
  IntegrationInstallRecord,
  IntegrationManagedFileRecord,
  IntegrationState,
} from './types';

const CLIENTS = ['codex', 'claude'] as const;
const REQUIRED_PERMISSIONS: Record<IntegrationClientId, readonly OutboundPermission[]> = {
  codex: ['responses', 'images'],
  claude: ['messages'],
};

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
  codexAuthHelper?: CodexAuthHelperConfig;
  homeDir?: string;
}

interface ResolvedClientKey {
  binding: IntegrationKeyBinding;
  row: OutboundKeyDbRow;
  secret: string;
  created: boolean;
}

interface BoundKeyDetails {
  status?: IntegrationKeyBindingStatus;
  secret?: string;
  usable: boolean;
  message?: string;
}

/** Coordinates per-client least-privilege keys with reversible native CLI config edits. */
export class IntegrationManager {
  private readonly homeDir: string;
  private readonly codexAuthHelper: CodexAuthHelperConfig;

  constructor(private readonly options: IntegrationManagerOptions) {
    assertLoopbackGatewayUrl(options.gatewayBaseUrl);
    this.homeDir = options.homeDir ?? homedir();
    this.codexAuthHelper = options.codexAuthHelper ?? currentProcessCodexAuthHelper(options.configPath);
  }

  async listStatus(): Promise<IntegrationClientStatus[]> {
    const state = this.options.stateStore.load();
    const rows = await this.options.keyDb.outboundApiKeysList();
    return Promise.all(CLIENTS.map((client) => this.statusFor(client, state, rows)));
  }

  async plan(
    client: IntegrationClientId,
    configPath = this.defaultConfigPath(client),
  ): Promise<IntegrationChangePlan> {
    const state = this.options.stateStore.load();
    const record = state.clients[client];
    const target = record?.configPath ?? resolve(configPath);
    const status = await this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
    const changes = client === 'codex'
      ? ['model_provider', 'model_providers.omnicross', 'model_providers.omnicross.auth']
      : ['env.ANTHROPIC_BASE_URL', 'env.ANTHROPIC_AUTH_TOKEN', 'env.ANTHROPIC_API_KEY'];
    if (!record) {
      return { client, configPath: target, action: 'install', canApply: true, changes, warnings: [] };
    }
    if (status.status === 'enabled') {
      return { client, configPath: target, action: 'none', canApply: true, changes: [], warnings: [] };
    }
    const warnings = ['Configuration changed after installation; repair preserves unrelated current settings.'];
    if (client === 'codex' && record.credentialFile) {
      warnings.push('Repair migrates Codex away from managed auth.json and restores its original contents.');
    }
    return { client, configPath: target, action: 'repair', canApply: true, changes, warnings };
  }

  async install(
    client: IntegrationClientId,
    configPath = this.defaultConfigPath(client),
  ): Promise<IntegrationClientStatus> {
    const target = resolve(configPath);
    const state = this.options.stateStore.load();
    const previousState = cloneState(state);
    const existingRecord = state.clients[client];
    if (existingRecord) {
      const status = await this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
      if (status.status === 'enabled') return status;
      throw new IntegrationConflictError(
        `${client} integration configuration has drifted; repair or remove it before reinstalling`,
      );
    }

    const key = await this.ensureClientKey(client, state);
    const original = readOptional(target);
    const originalContent = original ?? '';
    const installed = this.renderInstalled(client, originalContent, key.secret);
    state.clients[client] = {
      client,
      configPath: target,
      originalExisted: original !== null,
      originalContent,
      originalHash: sha256(originalContent),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
    };
    const legacyRetirement = clearLegacyGatewayWhenUnused(state);

    try {
      persistStateThenFiles(this.options.stateStore, state, previousState, [
        { path: target, content: installed },
      ]);
    } catch (error) {
      if (key.created) await bestEffortRevoke(this.options.keyDb, key.binding.keyId);
      throw error;
    }
    await this.retireManagedKeys(state, [legacyRetirement]);
    return this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
  }

  async repair(client: IntegrationClientId): Promise<IntegrationClientStatus> {
    const state = this.options.stateStore.load();
    const record = state.clients[client];
    if (!record) return this.install(client);
    const previousState = cloneState(state);
    const currentFile = readOptional(record.configPath);
    const previousSecret = await this.installedSecret(client, state);
    if (client === 'claude' && currentFile !== null && !previousSecret) {
      throw new IntegrationConflictError(
        'Claude integration key state is missing; refusing to repair an ambiguous settings file',
      );
    }

    const key = await this.ensureClientKey(client, state);
    const current = currentFile ?? record.originalContent;
    const base = client === 'codex'
      ? restoreCodexBase(current, record.originalContent)
      : restoreClaudeBase(
          current,
          record.originalContent,
          record.gatewayBaseUrl,
          previousSecret ?? key.secret,
        );
    const installed = this.renderInstalled(client, base, key.secret);
    const changes: FileChange[] = [{ path: record.configPath, content: installed }];
    if (client === 'codex' && record.credentialFile) {
      const currentCredential = readOptional(record.credentialFile.path);
      if (managedFileDisposition(record.credentialFile, currentCredential) === 'installed') {
        changes.push({
          path: record.credentialFile.path,
          content: record.credentialFile.originalExisted ? record.credentialFile.originalContent : null,
        });
      }
    }

    Object.assign(record, {
      originalExisted: currentFile !== null || record.originalExisted,
      originalContent: base,
      originalHash: sha256(base),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
      credentialFile: undefined,
    });
    const legacyRetirement = clearLegacyGatewayWhenUnused(state);
    try {
      persistStateThenFiles(this.options.stateStore, state, previousState, changes);
    } catch (error) {
      if (key.created) await bestEffortRevoke(this.options.keyDb, key.binding.keyId);
      throw error;
    }
    await this.retireManagedKeys(state, [legacyRetirement]);
    return this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
  }

  async remove(client: IntegrationClientId): Promise<IntegrationClientStatus> {
    const state = this.options.stateStore.load();
    const previousState = cloneState(state);
    const record = state.clients[client];
    const binding = state.keyBindings?.[client];
    const changes: FileChange[] = [];

    if (record) {
      const files = [primaryManagedFile(record), ...(record.credentialFile ? [record.credentialFile] : [])];
      const currentFiles = files.map((file) => ({ file, current: readOptional(file.path) }));
      const dispositions = currentFiles.map(({ file, current }) => managedFileDisposition(file, current));
      if (dispositions.some((disposition) => disposition !== 'installed' && disposition !== 'restored')) {
        throw new IntegrationConflictError(
          `${client} configuration changed after Omnicross installed it; refusing to overwrite user edits`,
        );
      }
      changes.push(...currentFiles.flatMap(({ file }, index) => dispositions[index] === 'installed'
        ? [{ path: file.path, content: file.originalExisted ? file.originalContent : null }]
        : []));
      delete state.clients[client];
    }
    if (state.keyBindings) delete state.keyBindings[client];
    const legacyRetirement = clearLegacyGatewayWhenUnused(state);
    if (record || binding) persistStateThenFiles(this.options.stateStore, state, previousState, changes);
    await this.retireManagedKeys(state, [
      binding?.ownership === 'managed' ? binding.keyId : undefined,
      legacyRetirement,
    ]);
    return this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
  }

  /** Bind a user-confirmed access key and grant only this client's required endpoints. */
  async bindIntegrationKey(
    client: IntegrationClientId,
    keyId: string,
  ): Promise<IntegrationClientStatus> {
    const state = this.options.stateStore.load();
    const previousState = cloneState(state);
    const rows = await this.options.keyDb.outboundApiKeysList();
    const row = rows.find((candidate) => candidate.id === keyId);
    if (!row || !row.enabled || row.revokedAt !== null) {
      throw new IntegrationConflictError('The selected access key is missing, disabled, or revoked.');
    }
    const secret = await this.options.keyDb.outboundApiKeysReveal(keyId);
    if (!secret) {
      throw new IntegrationConflictError('The selected access key cannot be revealed and cannot power a CLI integration.');
    }

    const effective = [...effectiveOutboundPermissions(row.allowedEndpoints)];
    const previousPermissions = row.allowedEndpoints === undefined
      ? [...effective]
      : [...row.allowedEndpoints];
    const nextPermissions = [...effective];
    for (const required of REQUIRED_PERMISSIONS[client]) {
      if (!nextPermissions.includes(required)) nextPermissions.push(required);
    }
    const permissionsChanged = !samePermissions(effective, nextPermissions);
    if (permissionsChanged) {
      const updated = await this.options.keyDb.outboundApiKeysSetPermissions(keyId, nextPermissions);
      if (!updated) throw new IntegrationConflictError('The selected access key permissions could not be updated.');
    }

    const previousBinding = state.keyBindings?.[client];
    if (!state.keyBindings) state.keyBindings = {};
    state.keyBindings[client] = { keyId, ownership: 'selected' };
    const changes: FileChange[] = [];
    const record = state.clients[client];
    try {
      if (record) this.rebindInstalledClient(client, record, secret, changes);
      const legacyRetirement = clearLegacyGatewayWhenUnused(state);
      persistStateThenFiles(this.options.stateStore, state, previousState, changes);
      await this.retireManagedKeys(state, [
        previousBinding?.ownership === 'managed' ? previousBinding.keyId : undefined,
        legacyRetirement,
      ]);
    } catch (error) {
      if (permissionsChanged) {
        await this.options.keyDb.outboundApiKeysSetPermissions(keyId, previousPermissions).catch(() => false);
      }
      throw error;
    }
    return this.statusFor(client, state, await this.options.keyDb.outboundApiKeysList());
  }

  /** Rotate every Omnicross-managed client binding; user-selected keys remain untouched. */
  async rotateGatewayKey(): Promise<{ keyIds: Partial<Record<IntegrationClientId, string>> }> {
    const state = this.options.stateStore.load();
    const previousState = cloneState(state);
    const targets = CLIENTS.filter((client) => {
      const binding = state.keyBindings?.[client];
      return binding?.ownership === 'managed' || (!binding && !!state.clients[client]);
    });
    if (targets.length === 0) {
      throw new IntegrationConflictError('There are no Omnicross-managed integration keys to rotate.');
    }

    const previousManagedIds = new Set<string>();
    const created: ResolvedClientKey[] = [];
    const changes: FileChange[] = [];
    try {
      for (const client of targets) {
        const old = state.keyBindings?.[client];
        if (old?.ownership === 'managed') previousManagedIds.add(old.keyId);
        const next = await this.createManagedClientKey(client, state);
        created.push(next);
        const record = state.clients[client];
        if (record) this.rebindInstalledClient(client, record, next.secret, changes, true);
      }
      const legacyRetirement = clearLegacyGatewayWhenUnused(state);
      persistStateThenFiles(this.options.stateStore, state, previousState, changes);
      if (legacyRetirement) previousManagedIds.add(legacyRetirement);
      await this.retireManagedKeys(state, [...previousManagedIds]);
    } catch (error) {
      for (const key of created) await bestEffortRevoke(this.options.keyDb, key.binding.keyId);
      throw error;
    }
    const keyIds: Partial<Record<IntegrationClientId, string>> = {};
    for (const client of targets) {
      const keyId = state.keyBindings?.[client]?.keyId;
      if (keyId) keyIds[client] = keyId;
    }
    return { keyIds };
  }

  /** Resolve the plaintext only for the command-auth helper; callers must not log it. */
  async getIntegrationToken(client: IntegrationClientId): Promise<string> {
    const state = this.options.stateStore.load();
    const rows = await this.options.keyDb.outboundApiKeysList();
    const details = await this.boundKeyDetails(client, state, rows);
    if (!details.usable || !details.secret) {
      throw new Error(details.message ?? `${client} integration key is missing or unusable`);
    }
    return details.secret;
  }

  /** Compatibility alias for callers predating per-client bindings. */
  async getGatewayToken(client: IntegrationClientId = 'codex'): Promise<string> {
    return this.getIntegrationToken(client);
  }

  private async ensureClientKey(
    client: IntegrationClientId,
    state: IntegrationState,
  ): Promise<ResolvedClientKey> {
    const binding = state.keyBindings?.[client];
    if (!binding) return this.createManagedClientKey(client, state);
    const rows = await this.options.keyDb.outboundApiKeysList();
    const row = rows.find((candidate) => candidate.id === binding.keyId);
    const secret = row ? await this.options.keyDb.outboundApiKeysReveal(binding.keyId) : null;
    if (!row || !row.enabled || row.revokedAt !== null || !secret ||
      !hasRequiredPermissions(row, client)) {
      throw new IntegrationConflictError(
        `${client} integration key is missing, disabled, revoked, non-revealable, or lacks required permissions`,
      );
    }
    return { binding, row, secret, created: false };
  }

  private async createManagedClientKey(
    client: IntegrationClientId,
    state: IntegrationState,
  ): Promise<ResolvedClientKey> {
    const created = await createIntegrationKey(
      this.options.keyDb,
      `Omnicross ${displayClient(client)} integration`,
      [...REQUIRED_PERMISSIONS[client]],
    );
    const row = (await this.options.keyDb.outboundApiKeysList()).find((candidate) => candidate.id === created.id);
    if (!row) {
      await bestEffortRevoke(this.options.keyDb, created.id);
      throw new Error('new integration key was not persisted');
    }
    if (!state.keyBindings) state.keyBindings = {};
    const binding: IntegrationKeyBinding = { keyId: created.id, ownership: 'managed' };
    state.keyBindings[client] = binding;
    return { binding, row, secret: created.plaintextOnce, created: true };
  }

  private async installedSecret(
    client: IntegrationClientId,
    state: IntegrationState,
  ): Promise<string | undefined> {
    const binding = state.keyBindings?.[client];
    if (binding) return (await this.options.keyDb.outboundApiKeysReveal(binding.keyId)) ?? undefined;
    if (state.clients[client] && state.gatewayKey) return state.gatewayKey.secret;
    return undefined;
  }

  private rebindInstalledClient(
    client: IntegrationClientId,
    record: IntegrationInstallRecord,
    secret: string,
    changes: FileChange[],
    requirePristine = false,
  ): void {
    const current = readOptional(record.configPath);
    if (current === null) {
      throw new IntegrationConflictError(`${displayClient(client)} configuration is missing.`);
    }
    if (requirePristine && sha256(current) !== record.installedHash) {
      throw new IntegrationConflictError(`${displayClient(client)} configuration drift must be resolved first.`);
    }

    let base = current;
    if (client === 'codex') base = restoreCodexBase(current, record.originalContent);
    const installed = this.renderInstalled(client, base, secret);
    if (client === 'codex' && record.credentialFile) {
      const credential = readOptional(record.credentialFile.path);
      const disposition = managedFileDisposition(record.credentialFile, credential);
      if (requirePristine && disposition !== 'installed' && disposition !== 'restored') {
        throw new IntegrationConflictError('Codex auth.json drift must be resolved before key rotation.');
      }
      if (disposition === 'installed') {
        changes.push({
          path: record.credentialFile.path,
          content: record.credentialFile.originalExisted ? record.credentialFile.originalContent : null,
        });
      }
      record.credentialFile = undefined;
      record.originalContent = base;
      record.originalHash = sha256(base);
    }
    record.installedHash = sha256(installed);
    record.installedAt = Date.now();
    record.gatewayBaseUrl = this.options.gatewayBaseUrl;
    changes.push({ path: record.configPath, content: installed });
  }

  private async statusFor(
    client: IntegrationClientId,
    state: IntegrationState,
    rows: OutboundKeyDbRow[],
  ): Promise<IntegrationClientStatus> {
    const record = state.clients[client];
    const key = await this.boundKeyDetails(client, state, rows);
    if (!record) {
      return {
        client,
        status: 'not-installed',
        configPath: this.defaultConfigPath(client),
        ...(key.status ? { key: key.status } : {}),
      };
    }
    const shared = {
      client,
      configPath: record.configPath,
      installedAt: record.installedAt,
      gatewayBaseUrl: record.gatewayBaseUrl,
      ...(key.status ? { key: key.status } : {}),
    };
    const current = readOptional(record.configPath);
    if (current === null) return { ...shared, status: 'configuration-missing' };
    if (sha256(current) !== record.installedHash) return { ...shared, status: 'configuration-drift' };
    if (client === 'codex' && record.credentialFile) {
      return {
        ...shared,
        status: 'configuration-drift',
        message: 'Codex integration uses legacy managed auth.json and must be repaired.',
      };
    }
    if (!key.usable) return { ...shared, status: 'key-missing', message: key.message };
    return { ...shared, status: 'enabled' };
  }

  private async boundKeyDetails(
    client: IntegrationClientId,
    state: IntegrationState,
    rows: OutboundKeyDbRow[],
  ): Promise<BoundKeyDetails> {
    const explicit = state.keyBindings?.[client];
    const legacy = !explicit && state.clients[client] ? state.gatewayKey : undefined;
    const keyId = explicit?.keyId ?? legacy?.id;
    if (!keyId) return { usable: false, message: 'No access key is bound to this integration.' };
    const row = rows.find((candidate) => candidate.id === keyId);
    if (!row) return { usable: false, message: 'The bound access key no longer exists.' };
    const secret = legacy?.secret ?? await this.options.keyDb.outboundApiKeysReveal(keyId) ?? undefined;
    const allowedEndpoints = [...effectiveOutboundPermissions(row.allowedEndpoints)];
    const status: IntegrationKeyBindingStatus = {
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      ownership: explicit?.ownership ?? 'managed',
      revealable: !!secret,
      enabled: row.enabled,
      revoked: row.revokedAt !== null,
      allowedEndpoints,
      requiredEndpoints: [...REQUIRED_PERMISSIONS[client]],
      loopbackOnly: row.loopbackOnly === true,
    };
    if (!row.enabled || row.revokedAt !== null) {
      return { status, usable: false, message: 'The bound access key is disabled or revoked.' };
    }
    if (!secret) return { status, usable: false, message: 'The bound access key is not revealable.' };
    if (!hasRequiredPermissions(row, client)) {
      return { status, usable: false, message: 'The bound access key lacks required endpoint permissions.' };
    }
    return { status, secret, usable: true };
  }

  private async retireManagedKeys(
    state: IntegrationState,
    candidates: Array<string | undefined>,
  ): Promise<void> {
    const referenced = new Set(Object.values(state.keyBindings ?? {}).flatMap((binding) =>
      binding ? [binding.keyId] : []));
    if (state.gatewayKey) referenced.add(state.gatewayKey.id);
    for (const keyId of new Set(candidates.filter((value): value is string => !!value))) {
      if (!referenced.has(keyId)) await this.options.keyDb.outboundApiKeysRevoke(keyId);
    }
  }

  private defaultConfigPath(client: IntegrationClientId): string {
    return client === 'codex'
      ? join(this.homeDir, '.codex', 'config.toml')
      : join(this.homeDir, '.claude', 'settings.json');
  }

  private renderInstalled(client: IntegrationClientId, base: string, secret: string): string {
    if (client === 'claude') {
      return renderClaudeSettings(base, this.options.gatewayBaseUrl, secret);
    }
    return renderCodexConfig({
      existing: base,
      gatewayBaseUrl: this.options.gatewayBaseUrl,
      authHelper: this.codexAuthHelper,
    });
  }
}

function hasRequiredPermissions(row: OutboundKeyDbRow, client: IntegrationClientId): boolean {
  const allowed = effectiveOutboundPermissions(row.allowedEndpoints);
  return REQUIRED_PERMISSIONS[client].every((permission) => allowed.includes(permission));
}

function samePermissions(a: readonly OutboundPermission[], b: readonly OutboundPermission[]): boolean {
  return a.length === b.length && a.every((permission, index) => permission === b[index]);
}

function displayClient(client: IntegrationClientId): string {
  return client === 'codex' ? 'Codex' : 'Claude';
}

function clearLegacyGatewayWhenUnused(state: IntegrationState): string | undefined {
  if (!state.gatewayKey) return undefined;
  const hasUnmigratedClient = CLIENTS.some((client) => state.clients[client] && !state.keyBindings?.[client]);
  if (hasUnmigratedClient) return undefined;
  const keyId = state.gatewayKey.id;
  delete state.gatewayKey;
  return keyId;
}

function cloneState(state: IntegrationState): IntegrationState {
  return {
    version: 1,
    gatewayKey: state.gatewayKey ? { ...state.gatewayKey } : undefined,
    keyBindings: state.keyBindings
      ? Object.fromEntries(Object.entries(state.keyBindings).map(([client, binding]) =>
          [client, binding ? { ...binding } : binding]))
      : undefined,
    clients: Object.fromEntries(Object.entries(state.clients).map(([client, record]) => [
      client,
      record
        ? { ...record, credentialFile: record.credentialFile ? { ...record.credentialFile } : undefined }
        : record,
    ])),
  } as IntegrationState;
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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

interface FileChange {
  path: string;
  content: string | null;
}

function persistStateThenFiles(
  store: IntegrationStateStore,
  nextState: IntegrationState,
  previousState: IntegrationState,
  changes: FileChange[],
): void {
  store.save(nextState);
  try {
    applyFileChangesWithRollback(changes);
  } catch (error) {
    try { store.save(previousState); }
    catch {
      throw new IntegrationConflictError('CLI integration file update failed and its state rollback also failed.');
    }
    throw error;
  }
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

async function bestEffortRevoke(db: OutboundKeyDb, keyId: string): Promise<void> {
  try { await db.outboundApiKeysRevoke(keyId); }
  catch { /* preserve the primary state/configuration failure */ }
}

function assertLoopbackGatewayUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('gatewayBaseUrl must be a valid loopback URL'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const literalLoopback = host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    url.protocol !== 'http:' || !literalLoopback || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/'
  ) {
    throw new Error('native CLI integrations require an unauthenticated literal HTTP loopback gateway URL');
  }
}
