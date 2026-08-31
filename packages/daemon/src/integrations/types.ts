import type { OutboundPermission } from '@omnicross/core';

export type IntegrationClientId = 'codex' | 'claude';

export type IntegrationKeyOwnership = 'managed' | 'selected';

/** Secret-free pointer to an access key. The plaintext remains in the encrypted key store. */
export interface IntegrationKeyBinding {
  keyId: string;
  ownership: IntegrationKeyOwnership;
}

/** Redacted access-key state exposed by the integrations admin API. */
export interface IntegrationKeyBindingStatus {
  id: string;
  name: string;
  keyPrefix: string;
  ownership: IntegrationKeyOwnership;
  revealable: boolean;
  enabled: boolean;
  revoked: boolean;
  allowedEndpoints: OutboundPermission[];
  requiredEndpoints: OutboundPermission[];
  loopbackOnly: boolean;
}

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
  /** Selected key metadata only; never contains plaintext or the encrypted envelope. */
  key?: IntegrationKeyBindingStatus;
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
  /** Codex auth.json snapshot and installed hash; absent on legacy records. */
  credentialFile?: IntegrationManagedFileRecord;
}

export interface IntegrationManagedFileRecord {
  path: string;
  originalExisted: boolean;
  /** Encrypted by IntegrationStateStore before it reaches disk. */
  originalContent: string;
  originalHash: string;
  installedHash: string;
}

export interface IntegrationGatewayKeyRecord {
  id: string;
  /** Encrypted by IntegrationStateStore before it reaches disk. */
  secret: string;
  createdAt: number;
}

export interface IntegrationState {
  version: 1;
  /** Legacy shared-key layout. New installs use `keyBindings`; retained for safe migration. */
  gatewayKey?: IntegrationGatewayKeyRecord;
  keyBindings?: Partial<Record<IntegrationClientId, IntegrationKeyBinding>>;
  clients: Partial<Record<IntegrationClientId, IntegrationInstallRecord>>;
}
