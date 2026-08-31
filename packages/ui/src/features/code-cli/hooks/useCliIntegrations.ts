import { useCallback, useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

import type {
  CliIntegrationClient,
  CliIntegrationPlanResult,
  CliIntegrationsOverview,
  MutationResult,
} from '@/daemon/types';

export type IntegrationBusyTarget = CliIntegrationClient | `bind-${CliIntegrationClient}` | 'rotate' | null;

export interface UseCliIntegrationsResult {
  loading: boolean;
  overview: CliIntegrationsOverview | null;
  busyTarget: IntegrationBusyTarget;
  error: string | null;
  refresh: () => Promise<void>;
  install: (client: CliIntegrationClient, configPath?: string) => Promise<MutationResult>;
  plan: (client: CliIntegrationClient, configPath?: string) => Promise<CliIntegrationPlanResult>;
  repair: (client: CliIntegrationClient) => Promise<MutationResult>;
  remove: (client: CliIntegrationClient) => Promise<MutationResult>;
  bindKey: (client: CliIntegrationClient, keyId: string) => Promise<MutationResult>;
  rotate: () => Promise<MutationResult>;
}

export function useCliIntegrations(): UseCliIntegrationsResult {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<CliIntegrationsOverview | null>(null);
  const [busyTarget, setBusyTarget] = useState<IntegrationBusyTarget>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    const result = await agent.cli.getIntegrations();
    if (result.success) {
      setOverview(result.overview);
      setError(null);
    } else {
      setError(result.message);
    }
    if (showLoading) setLoading(false);
  }, []);

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    let cancelled = false;
    void agent.cli.getIntegrations().then((result) => {
      if (cancelled) return;
      if (result.success) {
        setOverview(result.overview);
        setError(null);
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (
    target: Exclude<IntegrationBusyTarget, null>,
    mutation: () => Promise<MutationResult>,
  ): Promise<MutationResult> => {
    setBusyTarget(target);
    setError(null);
    try {
      const result = await mutation();
      if (!result.success) {
        setError(result.message ?? 'CLI integration operation failed');
        return result;
      }
      await load(false);
      return result;
    } finally {
      setBusyTarget(null);
    }
  }, [load]);

  const install = useCallback((client: CliIntegrationClient, configPath?: string) =>
    run(client, () => agent.cli.installIntegration(client, { configPath })), [run]);

  const plan = useCallback(async (
    client: CliIntegrationClient,
    configPath?: string,
  ): Promise<CliIntegrationPlanResult> => {
    setError(null);
    const result = await agent.cli.planIntegration(client, { configPath });
    if (!result.success) setError(result.message);
    return result;
  }, []);

  const repair = useCallback((client: CliIntegrationClient) =>
    run(client, () => agent.cli.repairIntegration(client)), [run]);

  const remove = useCallback((client: CliIntegrationClient) =>
    run(client, () => agent.cli.removeIntegration(client)), [run]);

  const bindKey = useCallback((client: CliIntegrationClient, keyId: string) =>
    run(`bind-${client}`, () => agent.cli.bindIntegrationKey(client, keyId)), [run]);

  const rotate = useCallback(() =>
    run('rotate', () => agent.cli.rotateIntegrationKey()), [run]);

  return { loading, overview, busyTarget, error, refresh, install, plan, repair, remove, bindKey, rotate };
}
