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

import type { ApiServerSettingsStore, OutboundApiServerConfig, OutboundProxyConfig } from '@omnicross/core';
import { OUTBOUND_API_SERVER_CONFIG_KEY } from '@omnicross/core/outbound-api';

import {
  decryptProxySegment,
  decryptWebhookSegment,
  encryptProxySegment,
  encryptWebhookSegment,
  type SecretBox,
} from '../secrets';

/** Shape of the daemon config.json this store reads/writes the `server` field of. */
interface ConfigFileShape {
  server?: unknown;
  [k: string]: unknown;
}

export class JsonApiServerSettingsStore implements ApiServerSettingsStore {
  /**
   * @param configPath the daemon config.json whose `server` field is backed.
   * @param box         OPTIONAL at-rest `SecretBox` (upstream-proxy). When set, the
   *                    `server.proxy.*` passwords are encrypted-on-`set` /
   *                    decrypted-on-`get` (the settings-store path is otherwise not
   *                    secret-aware — every OTHER server field is non-secret). Null
   *                    ⇒ passthrough (legacy/pure tests unchanged).
   */
  constructor(
    private readonly configPath: string,
    private readonly box: SecretBox | null = null,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    if (key !== OUTBOUND_API_SERVER_CONFIG_KEY) return undefined;
    const file = this.readFile();
    if (file.server === undefined) return undefined;
    return this.decryptSecrets(file.server as OutboundApiServerConfig) as T;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    if (key !== OUTBOUND_API_SERVER_CONFIG_KEY) return;
    const file = this.readFile();
    file.server = this.encryptSecrets(value as OutboundApiServerConfig);
    writeFileSync(this.configPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
  }

  /** Encrypt the proxy passwords + webhook secrets before persisting (no-op without a box). */
  private encryptSecrets(config: OutboundApiServerConfig): OutboundApiServerConfig {
    if (!this.box) return config;
    let out = config;
    if (out?.proxy) out = { ...out, proxy: encryptProxySegment(out.proxy, this.box) as OutboundProxyConfig };
    if (out?.webhook) out = { ...out, webhook: encryptWebhookSegment(out.webhook, this.box) };
    return out;
  }

  /** Decrypt the proxy passwords + webhook secrets on read (no-op without a box). */
  private decryptSecrets(config: OutboundApiServerConfig): OutboundApiServerConfig {
    if (!this.box) return config;
    let out = config;
    if (out?.proxy) out = { ...out, proxy: decryptProxySegment(out.proxy, this.box) as OutboundProxyConfig };
    if (out?.webhook) out = { ...out, webhook: decryptWebhookSegment(out.webhook, this.box) };
    return out;
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
