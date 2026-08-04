import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runIntegrationToken } from '../commands/integration-token';
import { runIntegrations } from '../commands/integrations';
import { runSecrets } from '../commands/secrets';
import { defaultIntegrationsPath, defaultKeysPath } from '../commands/paths';
import { IntegrationStateStore } from '../integrations';
import { JsonOutboundKeyDb } from '../ports/JsonOutboundKeyDb';
import { resolveMasterKey, SecretBox } from '../secrets';

afterEach(() => vi.restoreAllMocks());

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'omnicross-integration-cli-'));
  const config = join(root, 'config.json');
  const master = join(root, 'master.key');
  const nextMaster = join(root, 'master-next.key');
  const codex = join(root, 'codex.toml');
  writeFileSync(config, '{"providers":[]}\n', 'utf8');
  return { root, config, master, nextMaster, codex };
}

describe('native integration CLI commands', () => {
  it('installs status/removes and token helper emits only the shared gateway token', async () => {
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

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await runIntegrationToken([
      '--config', p.config,
      '--master-key-file', p.master,
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^sk-omnicross-[0-9A-Za-z]+\n$/);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('sk-omnicross-'));

    await runIntegrations(['remove', 'codex', '--config', p.config, '--master-key-file', p.master]);
    expect(existsSync(p.codex)).toBe(false);
  });

  it('rejects a revoked integration key without printing it', async () => {
    const p = paths();
    mkdirSync(p.root, { recursive: true });
    const box = new SecretBox(resolveMasterKey({ keyFilePath: p.master }));
    const store = new IntegrationStateStore(defaultIntegrationsPath(p.config), box);
    const db = new JsonOutboundKeyDb(defaultKeysPath(p.config));
    const secret = 'sk-omnicross-RevokedExample';
    const row = await db.outboundApiKeysCreate({
      id: 'integration-revoked',
      name: 'revoked',
      keyHash: 'not-used',
      keyPrefix: 'sk-omnicross-',
      kind: 'integration',
      loopbackOnly: true,
    });
    await db.outboundApiKeysRevoke(row.id);
    store.save({ version: 1, clients: {}, gatewayKey: { id: row.id, secret, createdAt: 1 } });
    const write = vi.spyOn(process.stdout, 'write');
    await expect(runIntegrationToken([
      '--config', p.config, '--master-key-file', p.master,
    ])).rejects.toThrow(/revoked/);
    expect(write).not.toHaveBeenCalled();
  });

  it('master-key rotation re-seals integration state and updates the Codex helper path', async () => {
    const p = paths();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await runIntegrations([
      'install', 'codex', '--config', p.config,
      '--gateway-base-url', 'http://127.0.0.1:8765',
      '--master-key-file', p.master,
      '--target', p.codex,
    ]);
    const before = readFileSync(p.codex, 'utf8');
    expect(before).toContain(p.master.replace(/\\/g, '\\\\'));

    await runSecrets([
      'rotate', '--config', p.config,
      '--master-key-file', p.master,
      '--new-master-key-file', p.nextMaster,
    ]);
    const after = readFileSync(p.codex, 'utf8');
    expect(after).toContain(p.nextMaster.replace(/\\/g, '\\\\'));
    expect(after).not.toContain(p.master.replace(/\\/g, '\\\\'));

    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    await runIntegrationToken([
      '--config', p.config, '--master-key-file', p.nextMaster,
    ]);
    expect(output.join('')).toMatch(/^sk-omnicross-/);
    await expect(runIntegrationToken([
      '--config', p.config, '--master-key-file', p.master,
    ])).rejects.toThrow(/decrypt/);
  });
});
