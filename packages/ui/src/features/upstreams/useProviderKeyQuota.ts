/**
 * useProviderKeyQuota — a compact BYO key-pool quota summary for the upstreams
 * sidebar rows.
 *
 * One read-only `GET /providers/:id/keys` per provider (secret-free; the quota
 * field rides the daemon's 5-minute read-through cache), reduced to the
 * MOST-USED key per window id — the honest "is anything in this pool running
 * hot" signal. Failures are swallowed (quota is best-effort display); the
 * per-key progress bars + forced refresh stay in the provider-details key
 * pool section, which this only summarizes.
 */

import { useEffect, useState } from 'react';

import { agent } from '@/shared/agent';

export interface KeyQuotaSummaryWindow {
  id: string;
  label: string;
  usedPercent: number | null;
  resetsAt?: string;
}

/** Compact chip label for a window id — universal shorthand, no locale churn
 * (the localized full labels live in the key-pool section). */
export function quotaChipLabel(id: string, label: string): string {
  if (id === 'five-hour') return '5h';
  if (id === 'seven-day' || id === 'weekly') return '7d';
  if (id === 'thirty-day' || id === 'monthly') return 'mo';
  return label;
}

/** Worst-case (most-used key) per window id across each provider's key pool. */
export function useProviderKeyQuotaSummaries(
  providerIds: readonly string[],
): Map<string, KeyQuotaSummaryWindow[]> {
  const [summaries, setSummaries] = useState<Map<string, KeyQuotaSummaryWindow[]>>(new Map());
  const idsKey = providerIds.join('\0');
  useEffect(() => {
    const ids = idsKey ? idsKey.split('\0') : [];
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next = new Map<string, KeyQuotaSummaryWindow[]>();
      await Promise.all(
        ids.map(async (providerId) => {
          try {
            const keys = await agent.llmConfig.getApiKeys(providerId);
            const worst = new Map<string, KeyQuotaSummaryWindow>();
            for (const entry of keys) {
              for (const window of entry.quota?.windows ?? []) {
                if (window.usedPercent === null || window.usedPercent === undefined) continue;
                const existing = worst.get(window.id);
                if (!existing || (existing.usedPercent ?? -1) < window.usedPercent) {
                  worst.set(window.id, {
                    id: window.id,
                    label: window.label,
                    usedPercent: window.usedPercent,
                    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
                  });
                }
              }
            }
            if (worst.size > 0) next.set(providerId, [...worst.values()]);
          } catch {
            // quota is best-effort display — a failed keys read drops the chip
          }
        }),
      );
      if (!cancelled) setSummaries(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey]);
  return summaries;
}
