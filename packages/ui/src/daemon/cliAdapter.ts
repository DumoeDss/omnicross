/**
 * cliAdapter.ts — the daemon ⇄ Code CLI page adapter.
 *
 * Wraps the daemon's `/admin/api/cli` routes: list availability, launch a CLI in
 * an external terminal (pointed at the daemon proxy), list + stop running
 * launches. SECRET DISCIPLINE: the launch response is status-only (sessionId +
 * resolved provider/model) — the route token never crosses back to the dashboard.
 */

import { adminClient } from './adminClient';
import type {
  AgentCliApi,
  CliIntegrationClient,
  CliIntegrationPlanResult,
  CliIntegrationsOverview,
  CliIntegrationsResult,
  CliLaunchResult,
  CliSession,
  CliStatus,
  MutationResult,
} from './types';

function failure(error: unknown, fallback: string): MutationResult {
  return { success: false, message: error instanceof Error ? error.message : fallback };
}

export function createCliAdapter(): AgentCliApi {
  return {
    async list(): Promise<CliStatus[]> {
      try {
        return (await adminClient.get<{ clis: CliStatus[] }>('/cli')).clis;
      } catch {
        return [];
      }
    },

    async install(cli: string): Promise<MutationResult> {
      try {
        await adminClient.post(`/cli/${encodeURIComponent(cli)}/install`, {});
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to install CLI' };
      }
    },

    async launch(
      cli: string,
      input?: { cwd?: string; providerId?: string; model?: string },
    ): Promise<CliLaunchResult> {
      try {
        const data = await adminClient.post<{ sessionId: string; providerId: string; model: string }>(
          `/cli/${encodeURIComponent(cli)}/launch`,
          input ?? {},
        );
        return { success: true, ...data };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to launch CLI' };
      }
    },

    async sessions(): Promise<CliSession[]> {
      try {
        return (await adminClient.get<{ sessions: CliSession[] }>('/cli/sessions')).sessions;
      } catch {
        return [];
      }
    },

    async stop(id: string): Promise<MutationResult> {
      try {
        await adminClient.delete(`/cli/sessions/${encodeURIComponent(id)}`);
        return { success: true };
      } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : 'failed to stop launch' };
      }
    },

    async getIntegrations(): Promise<CliIntegrationsResult> {
      try {
        const overview = await adminClient.get<CliIntegrationsOverview>('/integrations');
        return { success: true, overview };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'failed to load CLI integrations',
        };
      }
    },

    async planIntegration(
      client: CliIntegrationClient,
      input?: { configPath?: string },
    ): Promise<CliIntegrationPlanResult> {
      try {
        const configPath = input?.configPath?.trim();
        const data = await adminClient.post<{ plan: Extract<CliIntegrationPlanResult, { success: true }>['plan'] }>(
          `/integrations/${encodeURIComponent(client)}/plan`,
          configPath ? { configPath } : {},
        );
        return { success: true, plan: data.plan };
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : 'failed to preview CLI integration',
        };
      }
    },

    async installIntegration(
      client: CliIntegrationClient,
      input?: { configPath?: string },
    ): Promise<MutationResult> {
      try {
        const configPath = input?.configPath?.trim();
        await adminClient.post(`/integrations/${encodeURIComponent(client)}/install`,
          configPath ? { configPath } : {});
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to enable CLI integration');
      }
    },

    async removeIntegration(client: CliIntegrationClient): Promise<MutationResult> {
      try {
        await adminClient.delete(`/integrations/${encodeURIComponent(client)}`);
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to remove CLI integration');
      }
    },

    async repairIntegration(client: CliIntegrationClient): Promise<MutationResult> {
      try {
        await adminClient.post(`/integrations/${encodeURIComponent(client)}/repair`, {});
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to repair CLI integration');
      }
    },

    async bindIntegrationKey(client: CliIntegrationClient, keyId: string): Promise<MutationResult> {
      try {
        await adminClient.post(`/integrations/${encodeURIComponent(client)}/key`, { keyId });
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to bind CLI integration key');
      }
    },

    async rotateIntegrationKey(): Promise<MutationResult> {
      try {
        await adminClient.post('/integrations/rotate', {});
        return { success: true };
      } catch (err) {
        return failure(err, 'failed to rotate CLI integration key');
      }
    },
  };
}
