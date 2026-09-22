/** @vitest-environment jsdom */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OverviewSources } from '../overviewModel';
import type { DashboardSummary, UsageThroughputResult } from '@/daemon/types-usage-pricing';
import type { UseCliIntegrationsResult } from '../../code-cli/hooks/useCliIntegrations';

const state = vi.hoisted(() => ({ sources: {} as OverviewSources, throughput: {} as UsageThroughputResult }));
vi.mock('../useOverviewData', () => ({ useOverviewData: () => ({ sources: state.sources, refreshing: false, refresh: vi.fn() }) }));
vi.mock('../useLiveThroughput', () => ({ THROUGHPUT_POLL_MS: 5000, useLiveThroughput: () => ({ source: { state: 'ready', data: state.throughput }, refresh: vi.fn() }) }));
vi.mock('../../code-cli/hooks/useCliIntegrations', () => ({ useCliIntegrations: () => ({
  overview: { integrations: [{ client: 'codex', status: 'configuration-drift' }, { client: 'claude', status: 'not-installed' }] },
  loading: false, busyTarget: null, error: null,
} as UseCliIntegrationsResult) }));
vi.mock('@/shared/state/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { OverviewPage } from '../OverviewPage';

let container: HTMLDivElement;
let root: Root;
function usage(total: number, today = total): DashboardSummary {
  return { total: { eventCount: total }, today: { eventCount: today, costUsd: 0 } } as DashboardSummary;
}
function render() { act(() => root.render(<OverviewPage onNavigate={vi.fn()} />)); }
function wizard() { return container.querySelector('[aria-labelledby="quickstart-title"]'); }

beforeEach(() => {
  const unavailable = { state: 'unavailable' as const };
  state.sources = {
    gateway: { config: unavailable, status: unavailable, keys: unavailable, version: unavailable },
    accounts: unavailable, allowances: unavailable, keyQuotas: unavailable, audit: unavailable, integrations: unavailable,
    usage: { state: 'ready', data: usage(0) },
  };
  state.throughput = { available: false, collectedAt: Date.now() };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('quick start completion', () => {
  it('hides for an active installation while keeping CLI drift actionable', () => {
    state.sources.usage.data = usage(2560);
    render();
    expect(wizard()).toBeNull();
    expect(container.textContent).toContain('overview.integrations.repair');
  });

  it('stays hidden with historical usage even when today and live throughput are empty', () => {
    state.sources.usage.data = usage(2560, 0);
    render();
    expect(wizard()).toBeNull();
  });

  it('hides when the first live request arrives and does not reopen when the window goes idle', () => {
    render();
    expect(wizard()).not.toBeNull();
    // Partial window fixture — only the fields the wizard's liveness check
    // reads (requests / outputTokens); the full token breakdown is irrelevant
    // here, hence the through-unknown cast.
    state.throughput = { available: true, collectedAt: Date.now(), startedAt: Date.now(), retentionMs: 900000, bucketMs: 60000,
      windows: [{ windowMs: 300000, requests: 1, outputTokens: 10, outputTokensPerMinute: 2, costUsdPerMinute: 0, requestsPerMinute: 0.2, complete: true }], buckets: [],
    } as unknown as UsageThroughputResult;
    render();
    expect(wizard()).toBeNull();
    state.throughput = { available: false, collectedAt: Date.now() };
    state.sources.usage = { state: 'unavailable' };
    render();
    expect(wizard()).toBeNull();
  });

  it('waits for initial usage data instead of flashing the wizard during loading', () => {
    state.sources.usage = { state: 'loading' };
    render();
    expect(wizard()).toBeNull();
    state.sources.usage = { state: 'ready', data: usage(0) };
    render();
    expect(wizard()).not.toBeNull();
  });
});
