/**
 * useChatGptWeb — state + actions for the ChatGPT Web page.
 * One status snapshot, refresh, and the three mutations (login window,
 * login check, bridge start/stop) each with their own busy flag.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createChatGptWebAdapter } from '@/daemon/chatgptWebAdapter';
import type { ChatGptWebBridgeStartInput, ChatGptWebConfigSaveInput, ChatGptWebStatus } from '@/daemon/types-chatgpt-web';

const adapter = createChatGptWebAdapter();

export type ChatGptWebBusy = 'config-save' | 'tunnel-install' | 'codex-setup' | 'login' | 'login-check' | 'bridge-start' | 'bridge-stop' | null;

export function useChatGptWeb() {
  const [status, setStatus] = useState<ChatGptWebStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ChatGptWebBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const next = await adapter.status();
    if (!mounted.current) return;
    setStatus(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (
      target: Exclude<ChatGptWebBusy, null>,
      action: () => Promise<{ success: boolean; message?: string }>,
      onDone?: () => void,
    ): Promise<{ success: boolean; message?: string }> => {
      setBusy(target);
      setError(null);
      setNotice(null);
      const result = await action();
      if (!mounted.current) return result;
      setBusy(null);
      if (!result.success) {
        setError(result.message ?? 'request failed');
        return result;
      }
      onDone?.();
      await refresh();
      return result;
    },
    [refresh],
  );

  const saveConfig = useCallback(
    (input: ChatGptWebConfigSaveInput, message: string) =>
      run('config-save', () => adapter.saveConfig(input), () => setNotice(message)),
    [run],
  );

  const retryTunnelInstall = useCallback(
    (message: string) => run('tunnel-install', () => adapter.retryTunnelInstall(), () => setNotice(message)),
    [run],
  );

  const setupCodexProfile = useCallback(
    (input: { model: string }, message: string) =>
      run('codex-setup', () => adapter.setupCodexProfile(input), () => setNotice(message)),
    [run],
  );

  const openLoginWindow = useCallback(
    (message: string) => run('login', () => adapter.openLoginWindow(), () => setNotice(message)),
    [run],
  );

  const checkLogin = useCallback(
    (signedInMessage: string, signedOutMessage: string) =>
      run(
        'login-check',
        async () => {
          const result = await adapter.checkLogin();
          if (!result.success) return result;
          setNotice(result.authenticated ? signedInMessage : signedOutMessage);
          return { success: true };
        },
        undefined,
      ),
    [run],
  );

  const startBridge = useCallback(
    (input: ChatGptWebBridgeStartInput, message: string) =>
      run('bridge-start', () => adapter.startBridge(input), () => setNotice(message)),
    [run],
  );

  const stopBridge = useCallback(
    (message: string) => run('bridge-stop', () => adapter.stopBridge(), () => setNotice(message)),
    [run],
  );

  return {
    status,
    loading,
    busy,
    error,
    notice,
    refresh,
    saveConfig,
    retryTunnelInstall,
    setupCodexProfile,
    openLoginWindow,
    checkLogin,
    startBridge,
    stopBridge,
  };
}
