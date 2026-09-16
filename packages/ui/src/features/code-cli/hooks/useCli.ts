/**
 * useCli.ts — the Code CLI page aggregator hook.
 *
 * Loads the per-CLI availability list + running launches on mount, and exposes
 * launch / stop / refresh wired to `agent.cli`. Launch opens an external terminal
 * on the daemon host (status-only response — the route token never returns).
 */

import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

import type {
  CliLaunchResult,
  CliSession,
  CliStatus,
  CliUpgradeResult,
  CliVersionMap,
  MutationResult,
} from '@/daemon/types';

export interface UseCliResult {
  loading: boolean;
  clis: CliStatus[];
  sessions: CliSession[];
  busy: boolean;
  error: string | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  /** Installed + npm-latest versions per CLI (drives the version display). */
  versions: CliVersionMap;
  versionsLoading: boolean;
  refreshVersions: () => Promise<void>;
  install: (cli: string) => Promise<MutationResult>;
  upgrade: (cli: string) => Promise<CliUpgradeResult>;
  launch: (
    cli: string,
    input?: { cwd?: string; keyId?: string; providerId?: string; bindingId?: string },
  ) => Promise<CliLaunchResult>;
  stop: (id: string) => Promise<void>;
}

export function useCli(): UseCliResult {
  const [loading, setLoading] = useState(true);
  const [clis, setClis] = useState<CliStatus[]>([]);
  const [sessions, setSessions] = useState<CliSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<CliVersionMap>({});
  const [versionsLoading, setVersionsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextClis, nextSessions] = await Promise.all([agent.cli.list(), agent.cli.sessions()]);
    setClis(nextClis);
    setSessions(nextSessions);
  }, []);

  const refreshVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      setVersions(await agent.cli.versions());
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const [nextClis, nextSessions] = await Promise.all([agent.cli.list(), agent.cli.sessions()]);
      if (!cancelled) {
        setClis(nextClis);
        setSessions(nextSessions);
        setLoading(false);
      }
      // Version probes (one `--version` + one `npm view` per installed CLI) are
      // slower than the PATH list — load them after the cards can render.
      void refreshVersions();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshVersions]);

  const install = useCallback(
    async (cli: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.cli.install(cli);
        if (!result.success) setError(result.message ?? 'install failed');
        else await Promise.all([refresh(), refreshVersions()]);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshVersions],
  );

  const upgrade = useCallback(
    async (cli: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.cli.upgrade(cli);
        if (!result.success) setError(result.message ?? 'upgrade failed');
        else await Promise.all([refresh(), refreshVersions()]);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refresh, refreshVersions],
  );

  const launch = useCallback(
    async (cli: string, input?: { cwd?: string; keyId?: string; providerId?: string; bindingId?: string }) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.cli.launch(cli, input);
        if (!result.success) setError(result.message ?? 'launch failed');
        else await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const stop = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const result = await agent.cli.stop(id);
        if (!result.success) setError(result.message ?? 'failed to stop');
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    loading,
    clis,
    sessions,
    busy,
    error,
    clearError,
    refresh,
    versions,
    versionsLoading,
    refreshVersions,
    install,
    upgrade,
    launch,
    stop,
  };
}
