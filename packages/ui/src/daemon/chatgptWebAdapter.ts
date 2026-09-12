/**
 * chatgptWebAdapter.ts — the daemon ⇄ ChatGPT Web page adapter.
 *
 * Wraps the daemon's `/admin/api/chatgpt-web` routes: aggregated status,
 * opening the CDP-less login window, probing the persisted login cookie,
 * and the background bridge lifecycle.
 */

import { adminClient } from './adminClient';
import type {
  ChatGptWebApi,
  ChatGptWebBridgeStartInput,
  ChatGptWebBridgeStatus,
  ChatGptWebStatus,
} from './types-chatgpt-web';

function failure(error: unknown, fallback: string): { success: false; message: string } {
  return { success: false, message: error instanceof Error ? error.message : fallback };
}

export function createChatGptWebAdapter(): ChatGptWebApi {
  return {
    async status(): Promise<ChatGptWebStatus | null> {
      try {
        return await adminClient.get<ChatGptWebStatus>('/chatgpt-web');
      } catch {
        return null;
      }
    },

    async openLoginWindow(): Promise<{ success: boolean; message?: string }> {
      try {
        await adminClient.post('/chatgpt-web/login', {});
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to open the login window');
      }
    },

    async checkLogin(): Promise<{ success: boolean; authenticated: boolean; message?: string }> {
      try {
        const data = await adminClient.post<{ authenticated: boolean }>('/chatgpt-web/login-check', {});
        return { success: true, authenticated: data.authenticated === true };
      } catch (err) {
        return { ...failure(err, 'login check failed'), authenticated: false };
      }
    },

    async startBridge(
      input: ChatGptWebBridgeStartInput,
    ): Promise<{ success: boolean; message?: string; bridge?: ChatGptWebBridgeStatus }> {
      try {
        const bridge = await adminClient.post<ChatGptWebBridgeStatus>('/chatgpt-web/bridge', input);
        return { success: true, bridge };
      } catch (err) {
        return failure(err, 'failed to start the bridge');
      }
    },

    async stopBridge(): Promise<{ success: boolean; message?: string }> {
      try {
        await adminClient.delete('/chatgpt-web/bridge');
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to stop the bridge');
      }
    },
  };
}
