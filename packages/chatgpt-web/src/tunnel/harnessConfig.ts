/**
 * harnessConfig.ts — persisted full-harness configuration.
 *
 * Small JSON file holding the ChatGPT tunnel identity (tunnel id + runtime
 * API key) and the connector name the @-mention must select. Written by the
 * daemon's `chatgpt-web harness setup`, loaded by the bridge.
 *
 * @module @omnicross/chatgpt-web/tunnel/harnessConfig
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isValidTunnelId } from './tunnelClient';

export const DEFAULT_CONNECTOR_NAME = 'Codex Native2';

export interface HarnessConfig {
  tunnelId: string;
  runtimeKey: string;
  connectorName: string;
  /** Directory for the tunnel binary + profiles (defaults under the config). */
  dataDir: string;
}

export function defaultHarnessConfigPath(): string {
  return join(homedir(), '.omnicross', 'chatgpt-web-harness.json');
}

export function defaultHarnessDataDir(): string {
  return join(homedir(), '.omnicross', 'chatgpt-web');
}

export function loadHarnessConfig(path = defaultHarnessConfigPath()): HarnessConfig | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HarnessConfig>;
    if (typeof parsed['tunnelId'] !== 'string' || !isValidTunnelId(parsed['tunnelId'])) return null;
    if (typeof parsed['runtimeKey'] !== 'string' || parsed['runtimeKey'].length < 8) return null;
    return {
      tunnelId: parsed['tunnelId'],
      runtimeKey: parsed['runtimeKey'],
      connectorName: typeof parsed['connectorName'] === 'string' && parsed['connectorName'].length > 0
        ? parsed['connectorName']
        : DEFAULT_CONNECTOR_NAME,
      dataDir: typeof parsed['dataDir'] === 'string' && parsed['dataDir'].length > 0
        ? parsed['dataDir']
        : defaultHarnessDataDir(),
    };
  } catch {
    return null;
  }
}

export interface SaveHarnessConfigInput {
  tunnelId: string;
  runtimeKey: string;
  connectorName?: string;
  dataDir?: string;
  path?: string;
}

export function saveHarnessConfig(input: SaveHarnessConfigInput): HarnessConfig {
  if (!isValidTunnelId(input.tunnelId)) {
    throw new Error('--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters');
  }
  if (!input.runtimeKey || input.runtimeKey.length < 8) {
    throw new Error('--runtime-key is missing or too short');
  }
  const config: HarnessConfig = {
    tunnelId: input.tunnelId,
    runtimeKey: input.runtimeKey,
    connectorName: input.connectorName?.trim() || DEFAULT_CONNECTOR_NAME,
    dataDir: input.dataDir?.trim() || defaultHarnessDataDir(),
  };
  const path = input.path ?? defaultHarnessConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export interface HarnessSetupChecklist {
  tunnelConfigured: boolean;
  connectorName: string;
  steps: string[];
}

/** The user-side setup steps reflected by `harness status`. */
export function harnessSetupChecklist(configPath = defaultHarnessConfigPath()): HarnessSetupChecklist {
  const config = loadHarnessConfig(configPath);
  return {
    tunnelConfigured: config !== null,
    connectorName: config?.connectorName ?? DEFAULT_CONNECTOR_NAME,
    steps: [
      '1. https://platform.openai.com/settings/organization/tunnels — create a tunnel, note its ID (tunnel_…).',
      '   (No Tunnels section? The feature is gated for some accounts; check you are on the same account as ChatGPT.)',
      '2. https://platform.openai.com/settings/organization/api-keys — create a runtime API key (organization-level; free; no model quota).',
      '3. omnicross chatgpt-web harness setup --tunnel-id <id> --runtime-key <key>',
      '4. omnicross chatgpt-web launch --harness --model chatgpt-web/pro   (starts the bridge + connects the tunnel)',
      '5. WHILE the bridge is running: https://chatgpt.com/#settings/Connectors → new connector: type Tunnel,',
      '   select your tunnel, auth none, name EXACTLY "'
        + (config?.connectorName ?? DEFAULT_CONNECTOR_NAME)
        + '", permissions: allow all actions. (The connector is only discoverable while the tunnel is healthy.)',
    ],
  };
}
