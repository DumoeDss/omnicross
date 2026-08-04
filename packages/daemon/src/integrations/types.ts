export type IntegrationClientId = 'codex' | 'claude';

export type IntegrationStatusKind =
  | 'not-installed'
  | 'enabled'
  | 'configuration-drift'
  | 'configuration-missing'
  | 'key-missing';

export interface IntegrationClientStatus {
  client: IntegrationClientId;
  status: IntegrationStatusKind;
  configPath: string;
  installedAt?: number;
  gatewayBaseUrl?: string;
  message?: string;
}

export interface IntegrationChangePlan {
  client: IntegrationClientId;
  configPath: string;
  action: 'install' | 'none' | 'repair';
  canApply: boolean;
  /** Redacted logical fields only; never file contents or credential values. */
  changes: string[];
  warnings: string[];
}

export interface IntegrationInstallRecord {
  client: IntegrationClientId;
  configPath: string;
  originalExisted: boolean;
  /** Encrypted by IntegrationStateStore before it reaches disk. */
  originalContent: string;
  originalHash: string;
  installedHash: string;
  installedAt: number;
  gatewayBaseUrl: string;
}

export interface IntegrationGatewayKeyRecord {
  id: string;
  /** Encrypted by IntegrationStateStore before it reaches disk. */
  secret: string;
  createdAt: number;
}

export interface IntegrationState {
  version: 1;
  gatewayKey?: IntegrationGatewayKeyRecord;
  clients: Partial<Record<IntegrationClientId, IntegrationInstallRecord>>;
}
