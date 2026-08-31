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
  it('installs/status/removes Codex command auth and prints token only for the helper action', async () => {
    const p = paths();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await runIntegrations([
      'install', 'codex', '--config', p.config,
      '--gateway-base-url', 'http://127.0.0.1:8765',
      '--master-key-file', p.master,
      '--target', p.codex,
    ]);
    expect(existsSync(p.codex)).toBe(true);
    expect(readFileSync(p.codex, 'utf8')).toContain('[model_providers.omnicross.auth]');
    expect(readFileSync(p.codex, 'utf8')).not.toContain('sk-omnicross-');
    expect(existsSync(p.codexAuth)).toBe(false);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    await runIntegrations([
      'token', 'codex', '--config', p.config, '--master-key-file', p.master,
    ]);
    expect(stdout).toHaveBeenCalledTimes(1);
    const token = String(stdout.mock.calls[0]?.[0]).trim();
    expect(token).toMatch(/^sk-omnicross-/);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining(token));

    await runIntegrations(['remove', 'codex', '--config', p.config, '--master-key-file', p.master]);
    expect(existsSync(p.codex)).toBe(false);
    expect(existsSync(p.codexAuth)).toBe(false);
  });

  it('master-key rotation re-seals key and integration stores without changing Codex config', async () => {
    const p = paths();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await runIntegrations([
      'install', 'codex', '--config', p.config,
      '--gateway-base-url', 'http://127.0.0.1:8765',
      '--master-key-file', p.master,
      '--target', p.codex,
    ]);
    const beforeConfig = readFileSync(p.codex, 'utf8');
    const beforeBinding = new IntegrationStateStore(
      defaultIntegrationsPath(p.config),
      new SecretBox(resolveMasterKey({ keyFilePath: p.master })),
    ).load().keyBindings?.codex;

    await runSecrets([
      'rotate', '--config', p.config,
      '--master-key-file', p.master,
      '--new-master-key-file', p.nextMaster,
    ]);
    expect(readFileSync(p.codex, 'utf8')).toBe(beforeConfig);
    expect(existsSync(p.codexAuth)).toBe(false);

    const nextStore = new IntegrationStateStore(
      defaultIntegrationsPath(p.config),
      new SecretBox(resolveMasterKey({ keyFilePath: p.nextMaster })),
    );
    expect(nextStore.load().keyBindings?.codex).toEqual(beforeBinding);
    const oldStore = new IntegrationStateStore(
      defaultIntegrationsPath(p.config),
      new SecretBox(resolveMasterKey({ keyFilePath: p.master })),
    );
    expect(() => oldStore.load()).toThrow(/decrypt|authentication/i);
  });
});
