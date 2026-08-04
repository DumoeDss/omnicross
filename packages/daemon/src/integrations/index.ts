export { IntegrationManager, IntegrationConflictError } from './IntegrationManager';
export { IntegrationStateStore } from './IntegrationStateStore';
export {
  renderClaudeSettings,
  renderCodexConfig,
  restoreClaudeBase,
  restoreCodexBase,
} from './configAdapters';
export type {
  IntegrationClientId,
  IntegrationClientStatus,
  IntegrationChangePlan,
  IntegrationInstallRecord,
  IntegrationState,
  IntegrationStatusKind,
} from './types';
