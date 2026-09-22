/**
 * ensureChatGptWebBridgeProvider — the bridge-start hook that lands the
 * chatgpt-web bridge as an ordinary BYO provider row (native Responses wire),
 * so codex keeps a single `omnicross` provider and routes chatgpt-web/*
 * models through the normal mapping table.
 *
 * @module @omnicross/daemon/admin/__tests__/chatgptWebProvider.test
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureChatGptWebBridgeProvider } from '../adminApi';
import { loadConfig, saveConfig, setSecretBox } from '../../config';
import { resolveMasterKey, SecretBox } from '../../secrets';
import type { AdminApiDeps } from '../adminApi';

let tmpDir: string;
let configPath: string;
const reload = vi.fn();

function seedConfig(providers: unknown[]): void {
  saveConfig(configPath, {
    providers,
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  } as never);
}

function deps(): AdminApiDeps {
  return { configPath, llmConfig: { reload } } as unknown as AdminApiDeps;
}

beforeEach(() => {
  reload.mockClear();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-cgw-provider-'));
  configPath = join(tmpDir, 'config.json');
  setSecretBox(new SecretBox(() => resolveMasterKey({ keyFilePath: join(tmpDir, 'master.key') })));
});

afterEach(() => {
  setSecretBox(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ensureChatGptWebBridgeProvider', () => {
  it('creates the provider row on first bridge start (native responses wire, universal routes)', async () => {
    seedConfig([]);

    await ensureChatGptWebBridgeProvider(deps(), {
      baseUrl: 'http://127.0.0.1:17850/v1',
      token: 'bridge-token-1',
    });

    const cfg = loadConfig(configPath);
    expect(cfg.providers).toHaveLength(1);
    expect(cfg.providers[0]).toMatchObject({
      id: 'chatgpt-web',
      name: 'ChatGPT Web (bridge)',
      apiFormat: 'openai-response',
      baseUrl: 'http://127.0.0.1:17850/v1',
      enabled: true,
    });
    expect(cfg.providers[0].models).toEqual(['chatgpt-web/light', 'chatgpt-web/medium', 'chatgpt-web/high']);
    // Round-trips through the at-rest SecretBox…
    expect(cfg.providers[0].apiKey).toBe('bridge-token-1');
    // …and the token is never on disk in plaintext.
    expect(readFileSync(configPath, 'utf8')).not.toContain('bridge-token-1');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refreshes only baseUrl + apiKey on restart — operator edits on the row survive', async () => {
    seedConfig([{
      id: 'chatgpt-web',
      name: '我的桥',
      apiFormat: 'openai-response',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'stale-token',
      // Pro/Luna routes a discover-models run added stay put.
      models: ['chatgpt-web/light', 'chatgpt-web/pro'],
      enabled: false,
    }]);

    await ensureChatGptWebBridgeProvider(deps(), {
      baseUrl: 'http://127.0.0.1:17850/v1',
      token: 'bridge-token-2',
    });

    const row = loadConfig(configPath).providers.find((p) => p.id === 'chatgpt-web');
    expect(row).toMatchObject({
      name: '我的桥',
      baseUrl: 'http://127.0.0.1:17850/v1',
      apiKey: 'bridge-token-2',
      models: ['chatgpt-web/light', 'chatgpt-web/pro'],
      enabled: false,
    });
    expect(loadConfig(configPath).providers).toHaveLength(1);
  });
});
