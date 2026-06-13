/**
 * JsonApiServerSettingsStore — the daemon's file-backed `ApiServerSettingsStore`
 * port impl.
 *
 * The serving core persists the outbound-API server config (`{ enabled,
 * networkBinding, endpoints, port }`) under a SINGLE settings key
 * (`OUTBOUND_API_SERVER_CONFIG_KEY === 'outboundApiServer.config'`). Here that
 * store is the daemon's `config.json` `server`
 * field. `loadServerConfig(store)` / `saveServerConfig(store, cfg)` (core)
 * normalize + persist through this 2-method surface.
 *
 * Only the one outbound-API key is ever read/written — any other key is a no-op
 * miss (returns `undefined`) so the surface stays honest about what it backs.
 *
 * @module @omnicross/daemon/ports/JsonApiServerSettingsStore
 */

import { readFileSync, writeFileSync } from 'node:fs';

import type { ApiServerSettingsStore } from '@omnicross/core';
import { OUTBOUND_API_SERVER_CONFIG_KEY } from '@omnicross/core/outbound-api';

/** Shape of the daemon config.json this store reads/writes the `server` field of. */
interface ConfigFileShape {
  server?: unknown;
  [k: string]: unknown;
}

export class JsonApiServerSettingsStore implements ApiServerSettingsStore {
  constructor(private readonly configPath: string) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (key !== OUTBOUND_API_SERVER_CONFIG_KEY) return undefined;
    const file = this.readFile();
    return (file.server as T | undefined) ?? undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    if (key !== OUTBOUND_API_SERVER_CONFIG_KEY) return;
    const file = this.readFile();
    file.server = value;
    writeFileSync(this.configPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
  }

  /** Read the config.json, tolerating a missing/corrupt file (→ empty shape). */
  private readFile(): ConfigFileShape {
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as ConfigFileShape;
    } catch {
      /* missing or unreadable → behave as an empty config */
    }
    return {};
  }
}
