import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  const db = new JsonOutboundKeyDb(defaultKeysPath(configPath));
  const store = new IntegrationStateStore(
    defaultIntegrationsPath(configPath),
    new SecretBox(randomBytes(32)),
  );
  const manager = new IntegrationManager({
    configPath,
    gatewayBaseUrl: 'http://127.0.0.1:8765',
    keyDb: db,
    stateStore: store,
    helperCommand: 'C:\\Program Files\\nodejs\\node.exe',
    helperArgsPrefix: ['C:\\Omnicross\\cli.js'],
    homeDir: home,
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
        },
      },
    });
    const disk = readFileSync(defaultIntegrationsPath(f.configPath), 'utf8');
    expect(disk).not.toContain('$TOP_SECRET');
    expect(f.store.load().clients.codex?.originalContent).toBe('$TOP_SECRET must not bypass encryption');
  });

  it('installs Codex command auth without a plaintext key and restores the exact TOML', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    const original = '# user comment\r\nmodel_provider = "openai"\r\n\r\n[features]\r\napps = true\r\n';
    writeFileSync(codexPath, original, 'utf8');

    const status = await f.manager.install('codex');
    expect(status.status).toBe('enabled');
    const installed = readFileSync(codexPath, 'utf8');
    expect(installed).toContain('model_provider = "omnicross"');
    expect(installed).toContain('[model_providers.omnicross.auth]');
    expect(installed).toContain('integration-token');
    expect(installed).not.toContain('sk-omnicross-');

    const stateOnDisk = readFileSync(defaultIntegrationsPath(f.configPath), 'utf8');
    expect(stateOnDisk).not.toContain('sk-omnicross-');
    expect(stateOnDisk).not.toContain('model_provider = \\"openai\\"');
    expect(stateOnDisk).toContain('enc:v1:');

    await f.manager.remove('codex');
    expect(readFileSync(codexPath, 'utf8')).toBe(original);
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
    f.store.save(state);

    await expect(f.manager.repair('claude')).rejects.toBeInstanceOf(IntegrationConflictError);
    expect(readFileSync(settingsPath, 'utf8')).toBe(installed);
  });

  it('rotates the shared key, updates Claude, and revokes the old row', async () => {
    const f = fixture();
    await f.manager.install('claude');
    const settingsPath = join(f.home, '.claude', 'settings.json');
    const oldToken = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> })
      .env.ANTHROPIC_AUTH_TOKEN;
    const oldKeyId = f.store.load().gatewayKey?.id;

    const rotated = await f.manager.rotateGatewayKey();
    const nextToken = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> })
      .env.ANTHROPIC_AUTH_TOKEN;
    expect(nextToken).not.toBe(oldToken);
    expect(await f.manager.getGatewayToken()).toBe(nextToken);
    expect(rotated.keyId).not.toBe(oldKeyId);
    const rows = await f.db.outboundApiKeysList();
    expect(rows.find((row) => row.id === oldKeyId)?.revokedAt).not.toBeNull();
    expect(rows.find((row) => row.id === rotated.keyId)).toMatchObject({
      kind: 'integration', loopbackOnly: true, allowedEndpoints: ['responses', 'messages'],
    });
  });

  it('creates and later removes a previously absent config file', async () => {
    const f = fixture();
    const target = join(f.home, '.codex', 'config.toml');
    expect(existsSync(target)).toBe(false);
    await f.manager.install('codex');
    expect(existsSync(target)).toBe(true);
    await f.manager.remove('codex');
    expect(existsSync(target)).toBe(false);
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

  it('uses an absolute config path in the Codex token helper, independent of Codex CWD', async () => {
    const f = fixture();
    const relativeConfigPath = '.omnicross-integration-relative-config.json';
    const manager = new IntegrationManager({
      configPath: relativeConfigPath,
      gatewayBaseUrl: 'http://127.0.0.1:8765',
      keyDb: f.db,
      stateStore: f.store,
      helperCommand: 'node',
      helperArgsPrefix: ['C:\\Omnicross\\cli.js'],
      homeDir: f.home,
    });

    await manager.install('codex');
    const installed = readFileSync(join(f.home, '.codex', 'config.toml'), 'utf8');
    expect(installed).toContain(JSON.stringify(resolve(relativeConfigPath)));
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
