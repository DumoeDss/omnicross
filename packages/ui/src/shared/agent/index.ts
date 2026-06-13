/**
 * agent (design D3) — the app's local data seam. UNCONDITIONALLY daemon-backed:
 * there is NO host-bridge / global-injection detection (hard constraint). The
 * React layer stays a pure webview client. `agent.llmConfig` is the daemon
 * admin-API adapter.
 *
 * The Provider page imports `{ agent }` from `@/shared/agent` and calls
 * `agent.llmConfig.{...}` exactly as in the upstream UI.
 */

import i18n from '@/i18n';

import { createAccountsAdapter } from '@/daemon/accountsAdapter';
import { createCliAdapter } from '@/daemon/cliAdapter';
import { createLlmConfigAdapter } from '@/daemon/llmConfigAdapter';
import { createMigrationAdapter } from '@/daemon/migrationAdapter';
import { createApiServiceAdapter } from '@/daemon/serverConfigAdapter';
import type {
  AgentAccountsApi,
  AgentApiServiceApi,
  AgentCliApi,
  AgentLLMConfigApi,
} from '@/daemon/types';
import type { AgentMigrationApi } from '@/daemon/types-migration';

// Resolve the unsupported-discovery message via i18n at call time so it follows
// the active language (the adapter caches the string, but i18n is initialized
// before the agent is first used, and the message is re-read here).
function unsupportedDiscoveryMessage(): string {
  const t = i18n.t.bind(i18n);
  const msg = t('appLocal.discoveryUnsupportedFormat');
  return typeof msg === 'string' ? msg : 'Model discovery is not supported for this provider format yet.';
}

const llmConfig: AgentLLMConfigApi = createLlmConfigAdapter(unsupportedDiscoveryMessage());
const apiService: AgentApiServiceApi = createApiServiceAdapter();
const accounts: AgentAccountsApi = createAccountsAdapter();
const migration: AgentMigrationApi = createMigrationAdapter();
const cli: AgentCliApi = createCliAdapter();

export const agent = {
  llmConfig,
  apiService,
  accounts,
  migration,
  cli,
};

export type Agent = typeof agent;
