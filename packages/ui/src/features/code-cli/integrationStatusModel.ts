import type { CliIntegrationStatusKind } from '@/daemon/types';

export type IntegrationBadgeVariant = 'success' | 'secondary' | 'destructive' | 'outline';

export interface IntegrationStatusPresentation {
  labelKey: string;
  hintKey: string;
  badgeVariant: IntegrationBadgeVariant;
  canInstall: boolean;
  canRepair: boolean;
  canRemove: boolean;
  needsAttention: boolean;
  protectsUserChanges: boolean;
}

const PRESENTATION: Record<CliIntegrationStatusKind, IntegrationStatusPresentation> = {
  'not-installed': {
    labelKey: 'codeCli.persistent.status.notInstalled',
    hintKey: 'codeCli.persistent.hint.notInstalled',
    badgeVariant: 'secondary',
    canInstall: true,
    canRepair: false,
    canRemove: false,
    needsAttention: false,
    protectsUserChanges: false,
  },
  enabled: {
    labelKey: 'codeCli.persistent.status.enabled',
    hintKey: 'codeCli.persistent.hint.enabled',
    badgeVariant: 'success',
    canInstall: false,
    canRepair: false,
    canRemove: true,
    needsAttention: false,
    protectsUserChanges: false,
  },
  'configuration-drift': {
    labelKey: 'codeCli.persistent.status.drift',
    hintKey: 'codeCli.persistent.hint.drift',
    badgeVariant: 'destructive',
    canInstall: false,
    canRepair: true,
    canRemove: false,
    needsAttention: true,
    protectsUserChanges: true,
  },
  'configuration-missing': {
    labelKey: 'codeCli.persistent.status.missing',
    hintKey: 'codeCli.persistent.hint.missing',
    badgeVariant: 'destructive',
    canInstall: false,
    canRepair: true,
    canRemove: true,
    needsAttention: true,
    protectsUserChanges: false,
  },
  'key-missing': {
    labelKey: 'codeCli.persistent.status.keyMissing',
    hintKey: 'codeCli.persistent.hint.keyMissing',
    badgeVariant: 'destructive',
    canInstall: false,
    canRepair: false,
    canRemove: true,
    needsAttention: true,
    protectsUserChanges: false,
  },
};

export function integrationStatusPresentation(
  status: CliIntegrationStatusKind,
): IntegrationStatusPresentation {
  return PRESENTATION[status];
}

export function hasInstalledIntegration(statuses: readonly { status: CliIntegrationStatusKind }[]): boolean {
  return statuses.some((row) => row.status !== 'not-installed');
}

export function hasRotationConflict(statuses: readonly { status: CliIntegrationStatusKind }[]): boolean {
  return statuses.some((row) => row.status === 'configuration-drift');
}
