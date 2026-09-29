import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createIntegrationKey, createNamedKey } from '@omnicross/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultIntegrationsPath, defaultKeysPath } from '../commands/paths';
import { ONBOARDING_ACCESS_KEY_NAME, IntegrationConflictError, IntegrationManager, IntegrationStateStore } from '../integrations';
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

/** Fixture whose IntegrationManager reads a LIVE modelNaming segment (the
 *  daemon wires the outbound server's live getter the same way). */
function fixtureWithModelNaming(modelNaming: () => { realNames?: boolean } | undefined) {
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
    modelNaming,
  });
  return { root, home, configPath, db, store, manager };
}

describe('IntegrationManager', () => {
  it('a fresh install binds the auto-created onboarding key instead of minting a managed one', async () => {
    const f = fixture();
    const onboarding = await createNamedKey(f.db, ONBOARDING_ACCESS_KEY_NAME);
    await f.db.outboundApiKeysSetUpstreamBinding(onboarding.id, { mode: 'explicit', targets: [] });

    const status = await f.manager.install('codex');
    expect(status.key).toMatchObject({ id: onboarding.id, ownership: 'selected' });
    // The rendered config carries the ONBOARDING key's secret, and no managed
    // key was minted beside it.
    expect(await f.manager.getIntegrationToken('codex')).toBe(onboarding.plaintextOnce);
    const names = (await f.db.outboundApiKeysList()).map((row) => row.name);
    expect(names).toEqual([ONBOARDING_ACCESS_KEY_NAME]);
  });


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

  it('adopts a hand-written README-style provider table instead of failing, then restores it on remove', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    // The exact shape docs/README.zh.md §5③ teaches users to write by hand.
    const manual = [
      'model = "gpt-5.6-sol"',
      'model_provider = "omnicross"',
      '',
      '[model_providers.omnicross]',
      'name = "Omnicross Local Gateway"',
      'base_url = "http://127.0.0.1:8765/v1"',
      'wire_api = "responses"',
      'supports_websockets = false',
      'env_key = "OMNICROSS_API_KEY"',
      'http_headers = { "X-OpenAI-Actor-Authorization" = "omnicross" }',
      '',
      '[mcp_servers.local]',
      'command = "demo"',
      '',
    ].join('\r\n');
    writeFileSync(codexPath, manual, 'utf8');

    const status = await f.manager.install('codex');
    expect(status.status).toBe('enabled');
    const installed = readFileSync(codexPath, 'utf8');
    // The manual table (and its env_key) is superseded by the managed block.
    expect(installed).toContain('model_provider = "omnicross" # managed by Omnicross');
    expect(installed).toContain('[model_providers.omnicross.auth]');
    expect(installed).not.toContain('env_key = "OMNICROSS_API_KEY"');
    expect(installed.match(/^\[model_providers\.omnicross\]$/gm)).toHaveLength(1);
    // Unrelated tables and root keys survive adoption untouched.
    expect(installed).toContain('model = "gpt-5.6-sol"');
    expect(installed).toContain('[mcp_servers.local]');
    expect(installed).toContain('command = "demo"');

    await f.manager.remove('codex');
    expect(readFileSync(codexPath, 'utf8')).toBe(manual);
  });

  it('adoption strips dotted sub-tables of the unmanaged provider too', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    const manual = [
      '[model_providers.omnicross]',
      'name = "manual"',
      '',
      '[model_providers.omnicross.auth]',
      'type = "api_key"',
      '',
      '[model_providers.other]',
      'name = "keep me"',
      '',
    ].join('\n');
    writeFileSync(codexPath, manual, 'utf8');

    const status = await f.manager.install('codex');
    expect(status.status).toBe('enabled');
    const installed = readFileSync(codexPath, 'utf8');
    expect(installed.match(/^\[model_providers\.omnicross(\.auth)?\]$/gm)).toHaveLength(2);
    expect(installed).not.toContain('name = "manual"');
    expect(installed).not.toContain('type = "api_key"');
    expect(installed).toContain('[model_providers.other]');
    expect(installed).toContain('name = "keep me"');

    await f.manager.remove('codex');
    expect(readFileSync(codexPath, 'utf8')).toBe(manual);
  });

  it('still refuses an orphaned marker, with an actionable message', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(codexPath, '# >>> omnicross managed provider >>>\n[model_providers.omnicross]\n', 'utf8');

    await expect(f.manager.install('codex')).rejects.toThrow(/leftover\/incomplete Omnicross marker.*Delete the lines/s);
    expect((await f.manager.listStatus())[0].status).toBe('not-installed');
    expect(readFileSync(codexPath, 'utf8')).toBe('# >>> omnicross managed provider >>>\n[model_providers.omnicross]\n');
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

  it('binds a selected key without rewriting its stored row, and leaves every key in place', async () => {
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
    // Access keys hold every permission BY KIND — binding never rewrites the
    // stored list (the fresh client row keeps its absent list).
    const rows = await f.db.outboundApiKeysList();
    expect(rows.find((row) => row.id === selected.id)?.allowedEndpoints).toBeUndefined();
    // Rebinding is NOT a revocation: the superseded MANAGED key stays in place
    // (enabled, un-revoked) for manual cleanup.
    expect(rows.find((row) => row.id === oldManagedId)).toMatchObject({
      enabled: true,
      revokedAt: null,
    });

    await f.manager.remove('codex');
    const afterRemove = await f.db.outboundApiKeysList();
    expect(afterRemove.find((row) => row.id === selected.id)).toMatchObject({
      enabled: true,
      revokedAt: null,
    });
    expect(afterRemove.find((row) => row.id === oldManagedId)).toMatchObject({
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

  it('writes the Codex managed block with the runtime model_catalog_url (model-name-visibility)', async () => {
    const f = fixture();
    await f.manager.install('codex');
    const codexPath = join(f.home, '.codex', 'config.toml');
    const toml = readFileSync(codexPath, 'utf8');
    // The catalog URL rides the managed provider block; the gateway decides its
    // content (empty until modelNaming.realNames is on), so install alone is
    // behavior-neutral for the picker.
    expect(toml).toContain('model_catalog_url = "http://127.0.0.1:8765/v1/codex-model-catalog"');
    await f.manager.remove('codex');
    // Uninstall restores the pre-install state exactly (the file never existed,
    // so remove deletes it — no catalog residue).
    expect(existsSync(codexPath)).toBe(false);
  });

  it('modelNaming off installs Claude WITHOUT the gateway-discovery env; on adds it', async () => {
    let realNames = false;
    const f = fixtureWithModelNaming(() => ({ realNames }));
    const settingsPath = join(f.home, '.claude', 'settings.json');

    await f.manager.install('claude');
    let env = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();

    realNames = true;
    const rewritten = await f.manager.refreshInstalledClients();
    expect(rewritten).toEqual(['claude']);
    env = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1');
    // The rest of the managed env survives the rewrite.
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8765');
    expect(env.ANTHROPIC_AUTH_TOKEN).toMatch(/^sk-omnicross-/);

    realNames = false;
    await f.manager.refreshInstalledClients();
    env = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();

    // Uninstall still restores the original exactly (no discovery residue).
    await f.manager.remove('claude');
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('refreshInstalledClients is a no-op for a drifted install and without a Claude install', async () => {
    const f = fixtureWithModelNaming(() => ({ realNames: true }));
    expect(await f.manager.refreshInstalledClients()).toEqual([]);

    const settingsPath = join(f.home, '.claude', 'settings.json');
    mkdirSync(join(f.home, '.claude'), { recursive: true });
    writeFileSync(settingsPath, '{\n  "env": {}\n}\n', 'utf8');
    await f.manager.install('claude');
    // Drift the file: refresh must skip it (status reports drift; repair renders
    // with the live setting) and never throw.
    writeFileSync(settingsPath, '{\n  "env": {},\n  "userEdit": true\n}\n', 'utf8');
    expect(await f.manager.refreshInstalledClients()).toEqual([]);
  });

  it('comments out an external model_catalog_json at install; remove restores it verbatim', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    // Another tool's static catalog at the ROOT of config.toml (pre-install).
    const original = 'model_catalog_json = "C:/somewhere/models.json"\n';
    writeFileSync(codexPath, original, 'utf8');

    const plan = await f.manager.plan('codex');
    expect(plan.action).toBe('install');
    expect(plan.canApply).toBe(true);
    expect(plan.changes).toContain('model_providers.omnicross.model_catalog_url');
    expect(plan.warnings.join(' ')).toMatch(/model_catalog_json/);

    // Install proceeds and DISABLES the external key in place (commented,
    // marker-suffixed) so our runtime model-list discovery is not suppressed.
    const status = await f.manager.install('codex');
    expect(status.status).toBe('enabled');
    expect(status.message).toBeUndefined();
    const toml = readFileSync(codexPath, 'utf8');
    expect(toml).toContain(
      '# model_catalog_json = "C:/somewhere/models.json" # disabled by Omnicross',
    );
    expect(toml).toContain('model_catalog_url = "http://127.0.0.1:8765/v1/codex-model-catalog"');
    // The ACTIVE form is gone — that is the point.
    expect(toml).not.toMatch(/^model_catalog_json\s*=/m);

    // Uninstall restores the user's original exactly (active key back).
    await f.manager.remove('codex');
    expect(readFileSync(codexPath, 'utf8')).toBe(original);
  });

  it('a re-enabled external catalog is drift; repair re-disables it', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    const codexPath = join(codexDir, 'config.toml');
    mkdirSync(codexDir, { recursive: true });
    const original = 'model_catalog_json = "C:/somewhere/models.json"\n';
    writeFileSync(codexPath, original, 'utf8');
    await f.manager.install('codex');

    // The other tool (or the user) re-writes the active key post-install.
    writeFileSync(codexPath, 'model_catalog_json = "C:/elsewhere/models.json"\n', 'utf8');
    const drifted = (await f.manager.listStatus()).find((s) => s.client === 'codex');
    expect(drifted?.status).toBe('configuration-drift');

    // Repair disables it again — preserving the CURRENT value (repair keeps
    // unrelated user edits; only our managed bits are re-applied).
    await f.manager.repair('codex');
    const toml = readFileSync(codexPath, 'utf8');
    expect(toml).not.toMatch(/^model_catalog_json\s*=/m);
    expect(toml).toContain('# model_catalog_json = "C:/elsewhere/models.json" # disabled by Omnicross');
  });

  it('a commented-out or table-scoped model_catalog_json is NOT flagged', async () => {
    const f = fixture();
    const codexDir = join(f.home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, 'config.toml'),
      '# model_catalog_json = "C:/somewhere/models.json"\n[some_tool]\nmodel_catalog_json = "x"\n',
      'utf8',
    );
    const plan = await f.manager.plan('codex');
    expect(plan.warnings).toEqual([]);
    const status = await f.manager.install('codex');
    expect(status.message).toBeUndefined();
  });

  it('flags a pristine pre-discovery Codex install (plan repair + status message) and refresh upgrades it', async () => {
    const f = fixture();
    const codexPath = join(f.home, '.codex', 'config.toml');
    mkdirSync(join(f.home, '.codex'), { recursive: true });
    await f.manager.install('codex');

    // Simulate an install created by an OLDER Omnicross: strip the
    // model_catalog_url line the current renderer adds, and re-anchor the
    // installed hash so the file reads as pristine.
    const rendered = readFileSync(codexPath, 'utf8');
    const legacy = rendered.replace(/^\s*model_catalog_url = "[^"]+"\n/m, '');
    writeFileSync(codexPath, legacy, 'utf8');
    const state = f.store.load();
    state.clients.codex!.installedHash = createHash('sha256').update(legacy, 'utf8').digest('hex');
    f.store.save(state);

    // plan() offers repair (not a bare 'none') and explains why.
    const plan = await f.manager.plan('codex');
    expect(plan.action).toBe('repair');
    expect(plan.warnings.join(' ')).toMatch(/predates runtime model-list discovery/);

    // status stays enabled (routing works) but says the toggle is inert.
    const status = (await f.manager.listStatus()).find((s) => s.client === 'codex');
    expect(status?.status).toBe('enabled');
    expect(status?.message).toMatch(/predates runtime model-list discovery/);

    // The toggle flip (refreshInstalledClients) auto-upgrades the file.
    const rewritten = await f.manager.refreshInstalledClients();
    expect(rewritten).toContain('codex');
    expect(readFileSync(codexPath, 'utf8')).toContain(
      'model_catalog_url = "http://127.0.0.1:8765/v1/codex-model-catalog"',
    );
    // And the flag is clean afterwards.
    const after = (await f.manager.listStatus()).find((s) => s.client === 'codex');
    expect(after?.message).toBeUndefined();
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
