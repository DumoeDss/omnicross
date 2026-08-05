export { IntegrationManager, IntegrationConflictError } from './IntegrationManager';
export { IntegrationStateStore } from './IntegrationStateStore';
export {
  renderClaudeSettings,
  renderCodexAuth,
  renderCodexConfig,
  restoreClaudeBase,
  restoreCodexBase,
} from './configAdapters';
export type {
  IntegrationClientId,
  IntegrationClientStatus,
  IntegrationChangePlan,
  IntegrationInstallRecord,
  IntegrationManagedFileRecord,
  IntegrationState,
  IntegrationStatusKind,
} from './types';
