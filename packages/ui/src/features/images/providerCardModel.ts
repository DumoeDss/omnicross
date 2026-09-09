/**
 * providerCardModel — the pure projection behind the per-provider status cards
 * (images-settings-tab D2). Kept free of React so the display semantics are
 * unit-testable: row ordering, the honest bootstrap-unverified label, and the
 * evidence-age text inputs.
 */

import type { ImagesCapabilityStatus, ImagesProviderStatusRow } from '@/daemon/types';

export interface ProviderCardModel {
  providerId: string;
  label: string;
  available: boolean;
  /** Safe reason when unavailable; null when available. */
  reason: string | null;
  /** This provider's route keys affirmed by its own fresh evidence. */
  models: string[];
  /** Honest bootstrap boundary: available without verified protocol evidence. */
  unverified: boolean;
  /** Age of the freshest evidence in seconds; undefined when none. */
  evidenceAgeSeconds: number | undefined;
}

/** Display order: the default provider's row first, then alphabetical. */
export function providerCardRows(
  capability: ImagesCapabilityStatus | null,
): ProviderCardModel[] {
  const rows = capability?.providers ?? [];
  const defaultProvider = capability?.configured.provider;
  const isAntigravity = (providerId: string): boolean => providerId === 'antigravity-subscription';
  return [...rows]
    .sort((a, b) => {
      if (a.providerId === defaultProvider) return -1;
      if (b.providerId === defaultProvider) return 1;
      return a.providerId.localeCompare(b.providerId);
    })
    .map((row: ImagesProviderStatusRow) => ({
      providerId: row.providerId,
      label: isAntigravity(row.providerId) ? 'Antigravity' : 'Codex',
      available: row.available === true,
      reason: row.available ? null : row.reason,
      models: [...row.models],
      // The antigravity provider's v1 evidence is bootstrap-eligible by design
      // (entitlement-unknown + protocol-unverified → one real attempt). An
      // available row without evidence age is labeled as awaiting its first
      // real request — never reported as verified.
      unverified: row.available === true && row.evidence === null && isAntigravity(row.providerId),
      evidenceAgeSeconds: row.evidence
        ? Math.max(0, Math.floor(row.evidence.ageMs / 1000))
        : undefined,
    }));
}
