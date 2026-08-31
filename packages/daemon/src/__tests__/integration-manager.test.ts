import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIntegrationKey, createNamedKey } from '@omnicross/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultIntegrationsPath, defaultKeysPath } from '../commands/paths';
import { IntegrationConflictError, IntegrationManager, IntegrationStateStore } from '../integrations';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';
import { SecretBox } from '../secrets';

const dirs: string[] = [];

afterEach(() => {
  // Test temp directories are intentionally left to the OS temp cleaner on
  // Windows: no recursive destructive cleanup in the test process.
  dirs.length = 0;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-integration-'));
  dirs.push(root);
  const home = join(root, 'home');
  const configPath = join(root, 'config.json');
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath, '{"providers":[]}\n', 'utf8');
  const box = new SecretBox(randomBytes(32));
  const db = new JsonOutboundKeyDb(defaultKeysPath(configPath), box);
  const store = new IntegrationStateStore(defaultIntegrationsPath(configPath), box);
  const manager = new IntegrationManager({
    configPath,
    gatewayBaseUrl: 'http://127.0.0.1:8765',
    keyDb: db,
    stateStore: store,
    homeDir: home,
    codexAuthHelper: { command: 'node.exe', args: ['omnicross.js', 'integrations', 'token', 'codex'] },
  });
  return { root, home, configPath, db, store, manager };
}

describe('IntegrationManager', () => {
  it('encrypts arbitrary snapshots even when their content begins with $', () => {
    const f = fixture();
    f.store.save({
      version: 1,
      clients: {
        codex: {
          client: 'codex',
          configPath: 'C:\\tmp\\config.toml',
          originalExisted: true,
          originalContent: '$TOP_SECRET must not bypass encryption',
          originalHash: 'before',
          installedHash: 'after',
          installedAt: 1,
          gatewayBaseUrl: 'http://127.0.0.1:8765',
          credentialFile: {
            path: 'C:\\tmp\\auth.json',
            originalExisted: true,
            originalContent: '{"access_token":"credential snapshot"}',
            originalHash: 'credential-before',
            installedHash: 'credential-after',
          },
        },
      },
    });
    const disk = readFileSync(defaultIntegrationsPath(f.configPath), 'utf8');
    expect(disk).not.toContain('$TOP_SECRET');
    expect(disk).not.toContain('credential snapshot');
    expect(f.store.load().clients.codex?.originalContent).toBe('$TOP_SECRET must not bypass encryption');
    expect(f.store.load().clients.codex?.credentialFile?.originalContent)
      .toBe('{"access_token":"credential snapshot"}');
  });

  it('installs Codex command auth without touching auth.json, then restores the exact TOML', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    const original = '# user comment\r\nmodel_provider = "openai"\r\npreferred_auth_method = "chatgpt"\r\n\r\n[features]\r\napps = true\r\n';
    const originalAuth = '{"auth_mode":"chatgpt","tokens":{"access_token":"native-token"}}\n';
    writeFileSync(codexPath, original, 'utf8');
    writeFileSync(join(codexDir, 'auth.json'), originalAuth, 'utf8');

    const status = await f.manager.install('codex');
    expect(status.status).toBe('enabled');
    expect(status.key).toMatchObject({
      ownership: 'managed',
      revealable: true,
      allowedEndpoints: ['responses', 'images'],
      requiredEndpoints: ['responses', 'images'],
    });
    const installed = readFileSync(codexPath, 'utf8');
    expect(installed).toContain('model_provider = "omnicross"');
    expect(installed).toContain('preferred_auth_method = "chatgpt"');
    expect(installed).not.toContain('requires_openai_auth');
    expect(installed).toContain('[model_providers.omnicross.auth]');
    expect(installed).toContain('X-OpenAI-Actor-Authorization');
    expect(installed).not.toContain('sk-omnicross-');
    expect(readFileSync(join(codexDir, 'auth.json'), 'utf8')).toBe(originalAuth);
    expect(await f.manager.getIntegrationToken('codex')).toMatch(/^sk-omnicross-/);

    const stateOnDisk = readFileSync(defaultIntegrationsPath(f.configPath), 'utf8');
    expect(stateOnDisk).not.toContain('sk-omnicross-');
    expect(stateOnDisk).not.toContain('model_provider = \\"openai\\"');
    expect(stateOnDisk).not.toContain('native-token');
    expect(stateOnDisk).toContain('enc:v1:');
    expect(f.store.load()).toMatchObject({
      gatewayKey: undefined,
      keyBindings: { codex: { ownership: 'managed' } },
    });

    await f.manager.remove('codex');
    expect(readFileSync(codexPath, 'utf8')).toBe(original);
    expect(readFileSync(join(codexDir, 'auth.json'), 'utf8')).toBe(originalAuth);
  });

  it('changes Claude settings only, never .credentials.json, then restores exactly', async () => {
    const f = fixture();
    const claudeDir = join(f.home, '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    const credentialsPath = join(claudeDir, '.credentials.json');
    mkdirSync(claudeDir, { recursive: true });
    const original = '{\n  "theme": "dark",\n  "env": { "KEEP": "yes" }\n}\n';
    const nativeCredentials = '{"oauthAccount":{"accessToken":"native-do-not-touch"}}\n';
    writeFileSync(settingsPath, original, 'utf8');
    writeFileSync(credentialsPath, nativeCredentials, 'utf8');

    await f.manager.install('claude');
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      theme: string;
      env: Record<string, string>;
    };
    expect(installed.theme).toBe('dark');
    expect(installed.env.KEEP).toBe('yes');
    expect(installed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765');
    expect(installed.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^sk-omnicross-/);
    expect(readFileSync(credentialsPath, 'utf8')).toBe(nativeCredentials);

    await f.manager.remove('claude');
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(readFileSync(credentialsPath, 'utf8')).toBe(nativeCredentials);
  });

  it('refuses to overwrite user edits made after installation', async () => {
    const f = fixture();
    await f.manager.install('codex');
    const codexPath = join(f.home, '.codex', 'config.toml');
    writeFileSync(codexPath, readFileSync(codexPath, 'utf8') + '# user edit\n', 'utf8');

    await expect(f.manager.remove('codex')).rejects.toBeInstanceOf(IntegrationConflictError);
    expect((await f.manager.listStatus())[0].status).toBe('configuration-drift');
  });

  it('never treats auth.json changes as integration drift and preserves them during removal', async () => {
    const f = fixture();
    await f.manager.install('codex');
    const authPath = join(f.home, '.codex', 'auth.json');
    writeFileSync(authPath, '{"auth_mode":"apikey","OPENAI_API_KEY":"user-replacement"}\n', 'utf8');

    const status = (await f.manager.listStatus()).find((entry) => entry.client === 'codex');
    expect(status).toMatchObject({ status: 'enabled' });
    await f.manager.remove('codex');
    expect(readFileSync(authPath, 'utf8')).toContain('user-replacement');
  });

  it('returns a redacted plan without minting a key', async () => {
    const f = fixture();
    const plan = await f.manager.plan('claude');
    expect(plan).toMatchObject({ client: 'claude', action: 'install', canApply: true });
    expect(plan.changes).toContain('env.ANTHROPIC_AUTH_TOKEN');
    expect(JSON.stringify(plan)).not.toContain('sk-omnicross-');
    expect(await f.db.outboundApiKeysList()).toHaveLength(0);
    expect(existsSync(defaultIntegrationsPath(f.configPath))).toBe(false);
  });

  it('repairs Codex drift and later preserves unrelated edits on removal', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(codexPath, 'model_provider = "openai"\n', 'utf8');
    await f.manager.install('codex');
    writeFileSync(codexPath, readFileSync(codexPath, 'utf8') + '\n[mcp_servers.local]\ncommand = "demo"\n', 'utf8');

    expect((await f.manager.plan('codex')).action).toBe('repair');
    expect((await f.manager.repair('codex')).status).toBe('enabled');
    await f.manager.remove('codex');
    const restored = readFileSync(codexPath, 'utf8');
    expect(restored).toContain('model_provider = "openai"');
    expect(restored).toContain('[mcp_servers.local]');
    expect(restored).not.toContain('model_providers.omnicross');
  }, 10_000);

  it('refuses ambiguous Claude repair when the previous gateway secret state is missing', async () => {
    const f = fixture();
    await f.manager.install('claude');
    const settingsPath = join(f.home, '.claude', 'settings.json');
    const installed = readFileSync(settingsPath, 'utf8');
    const state = f.store.load();
    delete state.gatewayKey;
    if (state.keyBindings) delete state.keyBindings.claude;
    f.store.save(state);

    await expect(f.manager.repair('claude')).rejects.toBeInstanceOf(IntegrationConflictError);
    expect(readFileSync(settingsPath, 'utf8')).toBe(installed);
  });

  it('rotates per-client managed keys and revokes both old rows', async () => {
    const f = fixture();
    await f.manager.install('codex');
    await f.manager.install('claude');
    const settingsPath = join(f.home, '.claude', 'settings.json');
    const oldCodexToken = await f.manager.getIntegrationToken('codex');
    const oldClaudeToken = await f.manager.getIntegrationToken('claude');
    const oldBindings = f.store.load().keyBindings;

    const rotated = await f.manager.rotateGatewayKey();
    const nextClaudeToken = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> })
      .env.ANTHROPIC_AUTH_TOKEN;
    const nextCodexToken = await f.manager.getIntegrationToken('codex');
    expect(nextClaudeToken).not.toBe(oldClaudeToken);
    expect(nextCodexToken).not.toBe(oldCodexToken);
    expect(nextCodexToken).not.toBe(nextClaudeToken);
    expect(rotated.keyIds.codex).not.toBe(oldBindings?.codex?.keyId);
    expect(rotated.keyIds.claude).not.toBe(oldBindings?.claude?.keyId);
    const rows = await f.db.outboundApiKeysList();
    expect(rows.find((row) => row.id === oldBindings?.codex?.keyId)?.revokedAt).not.toBeNull();
    expect(rows.find((row) => row.id === oldBindings?.claude?.keyId)?.revokedAt).not.toBeNull();
    expect(rows.find((row) => row.id === rotated.keyIds.codex)).toMatchObject({
      kind: 'integration', loopbackOnly: true, allowedEndpoints: ['responses', 'images'],
    });
    expect(rows.find((row) => row.id === rotated.keyIds.claude)).toMatchObject({
      kind: 'integration', loopbackOnly: true, allowedEndpoints: ['messages'],
    });
  });

  it('creates and later removes a previously absent config file', async () => {
    const f = fixture();
    const target = join(f.home, '.codex', 'config.toml');
    expect(existsSync(target)).toBe(false);
    await f.manager.install('codex');
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(f.home, '.codex', 'auth.json'))).toBe(false);
    await f.manager.remove('codex');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(f.home, '.codex', 'auth.json'))).toBe(false);
  });

  it('rejects a non-loopback gateway URL', () => {
    const f = fixture();
    expect(() => new IntegrationManager({
      configPath: f.configPath,
      gatewayBaseUrl: 'http://192.168.1.9:8765',
      keyDb: f.db,
      stateStore: f.store,
    })).toThrow(/loopback/);
  });

  it('writes command auth to a custom Codex config target without creating auth.json', async () => {
    const f = fixture();
    const customDir = join(f.root, 'custom-codex-home');
    const customConfigPath = join(customDir, 'config.toml');
    const manager = new IntegrationManager({
      configPath: f.configPath,
      gatewayBaseUrl: 'http://127.0.0.1:8765',
      keyDb: f.db,
      stateStore: f.store,
      homeDir: f.home,
    });

    await manager.install('codex', customConfigPath);
    expect(existsSync(customConfigPath)).toBe(true);
    expect(readFileSync(customConfigPath, 'utf8')).toContain('[model_providers.omnicross.auth]');
    expect(existsSync(join(customDir, 'auth.json'))).toBe(false);
  });

  it('binds a selected key, grants Codex image permission, and does not revoke it on removal', async () => {
    const f = fixture();
    await f.manager.install('codex');
    const oldManagedId = f.store.load().keyBindings?.codex?.keyId;
    const selected = await createNamedKey(f.db, 'My reusable key');

    const status = await f.manager.bindIntegrationKey('codex', selected.id);
    expect(status).toMatchObject({
      status: 'enabled',
      key: { id: selected.id, ownership: 'selected' },
    });
    expect(await f.manager.getIntegrationToken('codex')).toBe(selected.plaintextOnce);
    const rows = await f.db.outboundApiKeysList();
    expect(rows.find((row) => row.id === selected.id)?.allowedEndpoints).toEqual([
      'chat', 'responses', 'messages', 'gemini', 'images',
    ]);
    expect(rows.find((row) => row.id === oldManagedId)?.revokedAt).not.toBeNull();

    await f.manager.remove('codex');
    expect((await f.db.outboundApiKeysList()).find((row) => row.id === selected.id)).toMatchObject({
      enabled: true,
      revokedAt: null,
    });
  });

  it('migrates a legacy shared key and restores the original Codex auth.json on repair', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    const authPath = join(codexDir, 'auth.json');
    mkdirSync(codexDir, { recursive: true });
    const original = 'model_provider = "openai"\npreferred_auth_method = "chatgpt"\n';
    const installed = [
      'model_provider = "omnicross" # managed by Omnicross',
      'preferred_auth_method = "apikey" # managed by Omnicross',
      '',
      '# >>> omnicross managed provider >>>',
      '[model_providers.omnicross]',
      'name = "Omnicross Local Gateway"',
      'base_url = "http://127.0.0.1:8765/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'supports_websockets = false',
      '# <<< omnicross managed provider <<<',
      '',
    ].join('\n');
    const originalAuth = '{"auth_mode":"chatgpt","tokens":{"access_token":"native"}}\n';
    const legacy = await createIntegrationKey(f.db, 'Legacy shared integration');
    const installedAuth = JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: legacy.plaintextOnce,
    }, null, 2) + '\n';
    writeFileSync(codexPath, installed, 'utf8');
    writeFileSync(authPath, installedAuth, 'utf8');
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    f.store.save({
      version: 1,
      gatewayKey: { id: legacy.id, secret: legacy.plaintextOnce, createdAt: legacy.createdAt },
      clients: {
        codex: {
          client: 'codex',
          configPath: codexPath,
          originalExisted: true,
          originalContent: original,
          originalHash: digest(original),
          installedHash: digest(installed),
          installedAt: 1,
          gatewayBaseUrl: 'http://127.0.0.1:8765',
          credentialFile: {
            path: authPath,
            originalExisted: true,
            originalContent: originalAuth,
            originalHash: digest(originalAuth),
            installedHash: digest(installedAuth),
          },
        },
      },
    });

    expect((await f.manager.listStatus())[0]).toMatchObject({ status: 'configuration-drift' });
    expect(await f.manager.repair('codex')).toMatchObject({ status: 'enabled' });
    expect(readFileSync(authPath, 'utf8')).toBe(originalAuth);
    expect(readFileSync(codexPath, 'utf8')).toContain('[model_providers.omnicross.auth]');
    expect(f.store.load()).toMatchObject({
      gatewayKey: undefined,
      keyBindings: { codex: { ownership: 'managed' } },
    });
    expect((await f.db.outboundApiKeysList()).find((row) => row.id === legacy.id)?.revokedAt).not.toBeNull();
  });

  it('rejects localhost names and URL query fragments for an unauthenticated gateway key', () => {
    const f = fixture();
    for (const gatewayBaseUrl of [
      'http://localhost:8765',
      'http://127.0.0.1:8765?unexpected=true',
      'http://127.0.0.1:8765#fragment',
    ]) {
      expect(() => new IntegrationManager({
        configPath: f.configPath,
        gatewayBaseUrl,
        keyDb: f.db,
        stateStore: f.store,
      })).toThrow(/literal HTTP loopback/);
    }
  });

  it('revokes a freshly minted key when state persistence fails before installation', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'save').mockImplementation(() => {
      throw new Error('state disk is unavailable');
    });

    await expect(f.manager.install('codex')).rejects.toThrow('state disk is unavailable');
    const rows = await f.db.outboundApiKeysList();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'integration', enabled: false });
    expect(rows[0].revokedAt).not.toBeNull();
  });
});
