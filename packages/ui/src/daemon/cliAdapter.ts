/**
 * cliAdapter.ts — the daemon ⇄ Code CLI page adapter.
 *
 * Wraps the daemon's `/admin/api/cli` routes: list availability, launch a CLI in
 * an external terminal (pointed at the daemon proxy), list + stop running
 * launches. SECRET DISCIPLINE: the launch response is status-only (sessionId +
 * resolved provider/model) — the route token never crosses back to the dashboard.
 */

import { adminClient } from './adminClient';
import type { AgentCliApi, CliLaunchResult, CliSession, CliStatus, MutationResult } from './types';

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
  };
}
