/**
 * types-chatgpt-web — shapes for the `/admin/api/chatgpt-web` surface.
 * Mirrors the daemon's chatgptWebApi views. No secrets: the harness runtime
 * key only ever appears as `hasRuntimeKey`.
 */

export interface ChatGptWebConfigStatus {
  present: boolean;
  connectorName: string | null;
  /** Truncated tunnel id (first 13 chars) — identification, not a secret. */
  tunnelId: string | null;
  hasRuntimeKey: boolean;
}

export interface ChatGptWebTunnelStatus {
  installed: boolean;
  installing: boolean;
  running: boolean;
  healthy: boolean;
  ready: boolean;
  detail: string;
}

export interface ChatGptWebLoginStatus {
  state: 'signed-in' | 'signed-out' | 'unknown';
  checkedAt: number | null;
}

export interface ChatGptWebBridgeStatus {
  running: boolean;
  baseUrl?: string;
  token?: string;
  model?: string;
  harness?: boolean;
  startedAt?: number;
}

export type ChatGptWebInstallState = 'idle' | 'installing' | 'done' | 'failed';

export interface ChatGptWebStatus {
  config: ChatGptWebConfigStatus;
  electronRuntimeInstalled: boolean;
  login: ChatGptWebLoginStatus;
  tunnel: ChatGptWebTunnelStatus;
  /** Background tunnel-client download state (kicked by the config save). */
  install: ChatGptWebInstallState;
  bridge: ChatGptWebBridgeStatus;
}

export interface ChatGptWebBridgeStartInput {
  model: string;
  harness: boolean;
}

export interface ChatGptWebConfigSaveInput {
  tunnelId: string;
  runtimeKey: string;
}

export interface ChatGptWebApi {
  status(): Promise<ChatGptWebStatus | null>;
  saveConfig(input: ChatGptWebConfigSaveInput): Promise<{ success: boolean; message?: string; status?: ChatGptWebStatus }>;
  retryTunnelInstall(): Promise<{ success: boolean; message?: string }>;
  openLoginWindow(): Promise<{ success: boolean; message?: string }>;
  checkLogin(): Promise<{ success: boolean; authenticated: boolean; message?: string }>;
  startBridge(input: ChatGptWebBridgeStartInput): Promise<{ success: boolean; message?: string; bridge?: ChatGptWebBridgeStatus }>;
  stopBridge(): Promise<{ success: boolean; message?: string }>;
}
