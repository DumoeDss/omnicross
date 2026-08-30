import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defaultServerConfig,
  OUTBOUND_API_SERVER_CONFIG_KEY,
} from '@omnicross/core/outbound-api';

import { JsonApiServerSettingsStore } from '../ports/JsonApiServerSettingsStore';
import { SecretBox } from '../secrets/SecretBox';

describe('JsonApiServerSettingsStore atomic snapshots', () => {
  it('preserves unrelated UTF-8 fields and secret encryption across set and exact rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-settings-store-'));
    try {
      const configPath = join(dir, 'config.json');
      writeFileSync(configPath, JSON.stringify({ unrelated: { label: '保留' } }, null, 2), 'utf8');
      const store = new JsonApiServerSettingsStore(
        configPath,
        new SecretBox(Buffer.alloc(32, 7)),
      );
      const initial = defaultServerConfig();
      initial.proxy = {
        global: { type: 'http', host: 'proxy.example', port: 8080, password: 'write-only-secret' },
      };
      await store.set(OUTBOUND_API_SERVER_CONFIG_KEY, initial);
      const before = readFileSync(configPath);
      expect(before.toString('utf8')).toContain('保留');
      expect(before.toString('utf8')).not.toContain('write-only-secret');
      expect(before.toString('utf8')).toContain('enc:v1:');
      expect([...before.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);

      const snapshot = store.captureDocumentSnapshot();
      const changed = defaultServerConfig();
      changed.images = { ...changed.images!, enabled: true };
      await store.set(OUTBOUND_API_SERVER_CONFIG_KEY, changed);
      expect(readFileSync(configPath).equals(before)).toBe(false);

      store.restoreDocumentSnapshot(snapshot);
      expect(readFileSync(configPath).equals(before)).toBe(true);
      const restored = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(restored['unrelated']).toEqual({ label: '保留' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the prior document unchanged when an injected atomic replace fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-settings-store-'));
    try {
      const configPath = join(dir, 'config.json');
      const seed = new JsonApiServerSettingsStore(configPath);
      await seed.set(OUTBOUND_API_SERVER_CONFIG_KEY, defaultServerConfig());
      const before = readFileSync(configPath);
      const failing = new JsonApiServerSettingsStore(configPath, null, () => {
        throw new Error('injected settings replace failure');
      });
      await expect(failing.set(OUTBOUND_API_SERVER_CONFIG_KEY, {
        ...defaultServerConfig(),
        enabled: true,
      })).rejects.toThrow('injected settings replace failure');
      expect(readFileSync(configPath).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores a previously missing document and retains missing/corrupt read behavior', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omnicross-settings-store-'));
    try {
      const configPath = join(dir, 'config.json');
      const store = new JsonApiServerSettingsStore(configPath);
      const absent = store.captureDocumentSnapshot();
      expect(await store.get(OUTBOUND_API_SERVER_CONFIG_KEY)).toBeUndefined();
      await store.set(OUTBOUND_API_SERVER_CONFIG_KEY, defaultServerConfig());
      expect(existsSync(configPath)).toBe(true);
      store.restoreDocumentSnapshot(absent);
      expect(existsSync(configPath)).toBe(false);

      writeFileSync(configPath, '{not-json', 'utf8');
      expect(await store.get(OUTBOUND_API_SERVER_CONFIG_KEY)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
