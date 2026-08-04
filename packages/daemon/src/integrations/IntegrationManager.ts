import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { createIntegrationKey, type OutboundKeyDb } from '@omnicross/core';

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
  IntegrationGatewayKeyRecord,
  IntegrationInstallRecord,
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
  helperCommand?: string;
  helperArgsPrefix?: string[];
  helperArgsSuffix?: string[];
  homeDir?: string;
}

/** Coordinates a least-privilege gateway key with reversible native CLI config edits. */
export class IntegrationManager {
  private readonly homeDir: string;
  /** Absolute so Codex's auth helper is independent of the project CWD. */
  private readonly configPath: string;

  constructor(private readonly options: IntegrationManagerOptions) {
    assertLoopbackGatewayUrl(options.gatewayBaseUrl);
    this.homeDir = options.homeDir ?? homedir();
    this.configPath = resolve(options.configPath);
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
      ? ['model_provider', 'model_providers.omnicross', 'model_providers.omnicross.auth']
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
      const current = readOptional(target);
      if (current !== null && sha256(current) === existingRecord.installedHash &&
        await this.isKeyUsable(state)) {
        return this.statusFor(client, state, true);
      }
      throw new IntegrationConflictError(
        `${client} integration configuration has drifted; restore or remove it before reinstalling`,
      );
    }

    const key = await this.ensureGatewayKey(state);
    const original = readOptional(target);
    const originalContent = original ?? '';
    const installed = this.renderInstalled(client, originalContent, key.secret);

    const record: IntegrationInstallRecord = {
      client,
      configPath: target,
      originalExisted: original !== null,
      originalContent,
      originalHash: sha256(originalContent),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
    };

    const prior = state.clients[client];
    state.clients[client] = record;
    this.options.stateStore.save(state);
    try {
      atomicWrite(target, installed);
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
    // Claude keeps the local gateway key in settings.json because it has no
    // command-auth equivalent. If state was lost, the old token cannot be
    // distinguished from a user edit, so preserving it as the next restore
    // snapshot would reintroduce a credential after a later remove.
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
    const prior = { ...record };
    Object.assign(record, {
      originalExisted: currentFile !== null || record.originalExisted,
      originalContent: base,
      originalHash: sha256(base),
      installedHash: sha256(installed),
      installedAt: Date.now(),
      gatewayBaseUrl: this.options.gatewayBaseUrl,
    });
    this.options.stateStore.save(state);
    try {
      atomicWrite(record.configPath, installed);
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

    const current = readOptional(record.configPath);
    const currentHash = sha256(current ?? '');
    const alreadyRestored = (record.originalExisted ? current !== null : current === null) &&
      currentHash === record.originalHash;
    if (!alreadyRestored && (current === null || currentHash !== record.installedHash)) {
      throw new IntegrationConflictError(
        `${client} configuration changed after Omnicross installed it; refusing to overwrite user edits`,
      );
    }
    if (!alreadyRestored) {
      if (record.originalExisted) atomicWrite(record.configPath, record.originalContent);
      else if (existsSync(record.configPath)) unlinkSync(record.configPath);
    }
    delete state.clients[client];
    this.options.stateStore.save(state);
    return this.statusFor(client, state, await this.isKeyUsable(state));
  }

  async rotateGatewayKey(): Promise<{ keyId: string }> {
    const state = this.options.stateStore.load();
    const previousGatewayKey = state.gatewayKey;
    const oldKeyId = state.gatewayKey?.id;
    const claude = state.clients.claude;
    let nextClaude: string | undefined;
    if (claude) {
      const current = readOptional(claude.configPath);
      if (current === null || sha256(current) !== claude.installedHash) {
        throw new IntegrationConflictError('Claude configuration drift must be resolved before key rotation');
      }
    }

    const created = await createIntegrationKey(this.options.keyDb, 'Omnicross native CLI integration');
    const nextGatewayKey: IntegrationGatewayKeyRecord = {
      id: created.id,
      secret: created.plaintextOnce,
      createdAt: created.createdAt,
    };
    state.gatewayKey = nextGatewayKey;
    if (claude) {
      const current = readOptional(claude.configPath) ?? '{}';
      nextClaude = renderClaudeSettings(current, this.options.gatewayBaseUrl, created.plaintextOnce);
      claude.installedHash = sha256(nextClaude);
    }
    try {
      this.options.stateStore.save(state);
      if (claude && nextClaude !== undefined) atomicWrite(claude.configPath, nextClaude);
    } catch (error) {
      state.gatewayKey = previousGatewayKey;
      if (claude) {
        const current = readOptional(claude.configPath);
        if (current !== null) claude.installedHash = sha256(current);
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

  private renderInstalled(client: IntegrationClientId, base: string, secret: string): string {
    if (client === 'claude') {
      return renderClaudeSettings(base, this.options.gatewayBaseUrl, secret);
    }
    return renderCodexConfig({
      existing: base,
      gatewayBaseUrl: this.options.gatewayBaseUrl,
      helperCommand: this.helperCommand(),
      helperArgs: [
            ...(this.options.helperArgsPrefix ?? this.defaultHelperArgsPrefix()),
            'integration-token',
            '--config',
            this.configPath,
        ...(this.options.helperArgsSuffix ?? []),
      ],
    });
  }

  private helperCommand(): string {
    return this.options.helperCommand ?? process.execPath;
  }

  private defaultHelperArgsPrefix(): string[] {
    const entry = process.argv[1];
    if (!entry) throw new Error('cannot determine the Omnicross CLI entry for Codex token helper');
    return [resolve(entry)];
  }
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
