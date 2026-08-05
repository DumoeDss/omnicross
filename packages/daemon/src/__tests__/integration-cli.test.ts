import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runIntegrations } from '../commands/integrations';
import { runSecrets } from '../commands/secrets';
import { defaultIntegrationsPath } from '../commands/paths';
import { IntegrationStateStore } from '../integrations';
import { resolveMasterKey, SecretBox } from '../secrets';

afterEach(() => vi.restoreAllMocks());

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-integration-cli-'));
  const config = join(root, 'config.json');
  const master = join(root, 'master.key');
  const nextMaster = join(root, 'master-next.key');
  const codex = join(root, 'codex.toml');
  const codexAuth = join(root, 'auth.json');
  writeFileSync(config, '{"providers":[]}\n', 'utf8');
  return { root, config, master, nextMaster, codex, codexAuth };
}

describe('native integration CLI commands', () => {
  it('installs status/removes Codex TOML and file-backed API-key auth', async () => {
    const p = paths();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await runIntegrations([
      'install', 'codex', '--config', p.config,
      '--gateway-base-url', 'http://127.0.0.1:8765',
      '--master-key-file', p.master,
      '--target', p.codex,
    ]);
    expect(existsSync(p.codex)).toBe(true);
    expect(readFileSync(p.codex, 'utf8')).not.toContain('sk-omnicross-');
    const auth = JSON.parse(readFileSync(p.codexAuth, 'utf8')) as {
      auth_mode: string;
      OPENAI_API_KEY: string;
    };
    expect(auth.auth_mode).toBe('apikey');
    expect(auth.OPENAI_API_KEY).toMatch(/^sk-omnicross-/);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('sk-omnicross-'));

    await runIntegrations(['remove', 'codex', '--config', p.config, '--master-key-file', p.master]);
    expect(existsSync(p.codex)).toBe(false);
    expect(existsSync(p.codexAuth)).toBe(false);
  });

  it('master-key rotation re-seals integration state without changing Codex files', async () => {
    const p = paths();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await runIntegrations([
      'install', 'codex', '--config', p.config,
      '--gateway-base-url', 'http://127.0.0.1:8765',
      '--master-key-file', p.master,
      '--target', p.codex,
    ]);
    const beforeConfig = readFileSync(p.codex, 'utf8');
    const beforeAuth = readFileSync(p.codexAuth, 'utf8');

    await runSecrets([
      'rotate', '--config', p.config,
      '--master-key-file', p.master,
      '--new-master-key-file', p.nextMaster,
    ]);
    expect(readFileSync(p.codex, 'utf8')).toBe(beforeConfig);
    expect(readFileSync(p.codexAuth, 'utf8')).toBe(beforeAuth);

    const nextStore = new IntegrationStateStore(
      defaultIntegrationsPath(p.config),
      new SecretBox(resolveMasterKey({ keyFilePath: p.nextMaster })),
    );
    expect(nextStore.load().gatewayKey?.secret).toBe(
      (JSON.parse(beforeAuth) as { OPENAI_API_KEY: string }).OPENAI_API_KEY,
    );
    const oldStore = new IntegrationStateStore(
      defaultIntegrationsPath(p.config),
      new SecretBox(resolveMasterKey({ keyFilePath: p.master })),
    );
    expect(() => oldStore.load()).toThrow(/decrypt|authentication/i);
  });
});
