import { describe, expect, it } from 'vitest';

import {
  buildOverviewModel,
  type OverviewAuditData,
  type OverviewGatewayStatus,
  type OverviewSource,
  type OverviewSources,
} from '../overviewModel';

import type {
  AccountAllowanceSnapshot,
  AccountsListResponse,
  SubscriptionAccountSanitized,
} from '../../../daemon/types-accounts';
import type { OutboundApiKeyInfo, OutboundApiServerConfig } from '../../../daemon/types-server';
import type { DashboardSummary } from '../../../daemon/types-usage-pricing';
import type { CliIntegrationsOverview } from '../../../daemon/types';

const NOW = Date.parse('2026-08-04T12:00:00.000Z');

function source<T>(data: T): OverviewSource<T> {
  return { state: 'ready', data };
}

function unavailable<T>(message = 'read failed'): OverviewSource<T> {
  return { state: 'unavailable', message };
}

const emptyAccounts: AccountsListResponse = {
  accounts: [],
  providerAccounts: { claude: [], codex: [], gemini: [], opencodego: [] },
};

const healthyAccount: SubscriptionAccountSanitized = {
  id: 'claude-1',
  label: 'Primary Claude',
  enabled: true,
  group: 'claude',
  tags: [],
  status: 'authorized',
  hasAccessToken: true,
  isActive: true,
  schedulable: true,
  health: 'healthy',
};

const baseConfig: OutboundApiServerConfig = {
  enabled: true,
  networkBinding: false,
  allowanceScheduling: {
    enabled: false,
    demoteAtPercent: 80,
    pauseAtPercent: 98,
    priorityPenalty: 100,
  },
  // Routing evidence comes from the downstream routes; the legacy endpoint
  // blocks are no longer a routing source.
  endpoints: [],
  bindings: [
    {
      id: 'r-chat', name: 'chat', enabled: true, endpoint: 'chat', fallback: 'next',
      target: { kind: 'provider', providerId: 'byo' }, models: ['gpt'],
    },
    {
      id: 'r-responses', name: 'responses', enabled: true, endpoint: 'responses', fallback: 'next',
      target: { kind: 'account-pool', providerId: 'codex' },
      modelMap: { codex: 'gpt', mini: 'mini' },
    },
    {
      id: 'r-messages', name: 'messages', enabled: true, endpoint: 'messages', fallback: 'next',
      target: { kind: 'account-pool', providerId: 'claude' },
      modelMap: { fable: 'sonnet', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' },
    },
    {
      id: 'r-gemini', name: 'gemini', enabled: true, endpoint: 'gemini', fallback: 'next',
      target: { kind: 'account-pool', providerId: 'gemini' }, defaultModel: 'pro',
    },
  ],
};

const baseStatus: OverviewGatewayStatus = {
  running: true,
  port: 8000,
  loopbackUrl: 'http://127.0.0.1:8000',
  lanUrl: null,
  formats: null,
  lanFormats: null,
  endpoints: [],
  version: '0.1.5',
};

const baseKeys: OutboundApiKeyInfo[] = [
  { id: 'key-1', name: 'operator', keyPrefix: 'omni', enabled: true, revoked: false, createdAt: NOW, lastUsedAt: NOW },
];

const baseUsage: DashboardSummary = {
  today: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 1.25,
    costSavedByCacheUsd: 0,
    eventCount: 2,
  },
  total: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 1.25,
    costSavedByCacheUsd: 0,
    eventCount: 2,
  },
  providers: { total: 2, enabled: 2 },
  outboundKeys: { total: 1, active: 1 },
  accounts: { total: 1, byProvider: { claude: 1 } },
  server: { running: true, port: 8000, uptimeMs: 120_000 },
  generatedAt: NOW,
};

const baseAllowances: AccountAllowanceSnapshot[] = [{
  providerId: 'claude',
  accountId: 'claude-1',
  source: 'oauth-usage-api',
  observedAt: new Date(NOW).toISOString(),
  windows: [{
    id: 'five-hour',
    label: '5 hour',
    scope: 'all',
    usedPercent: 42,
    state: 'fresh',
  }],
}];

const baseIntegrations: CliIntegrationsOverview = {
  integrations: [
    { client: 'codex', status: 'enabled', configPath: 'codex.toml', gatewayBaseUrl: 'http://127.0.0.1:8000' },
    { client: 'claude', status: 'enabled', configPath: 'settings.json', gatewayBaseUrl: 'http://127.0.0.1:8000' },
  ],
  gateway: baseStatus,
};

const baseAudit: OverviewAuditData = {
  complete: true,
  requestCount: 2,
  errorCount: 1,
};

function healthySources(overrides: Partial<OverviewSources> = {}): OverviewSources {
  return {
    gateway: {
      config: source(baseConfig),
      status: source(baseStatus),
      keys: source(baseKeys),
      version: source('0.1.5'),
      ...overrides.gateway,
    },
    accounts: source({ ...emptyAccounts, providerAccounts: { ...emptyAccounts.providerAccounts, claude: [healthyAccount] } }),
    allowances: source(baseAllowances),
    usage: source(baseUsage),
    integrations: source(baseIntegrations),
    audit: source(baseAudit),
    ...overrides,
  };
}

describe('buildOverviewModel', () => {
  it('builds an operational model from healthy live sources', () => {
    const view = buildOverviewModel(healthySources(), NOW);

    expect(view.overallState).toBe('operational');
    expect(view.pathOperational).toBe(true);
    expect(view.stages.map((stage) => stage.state)).toEqual(['ready', 'ready', 'ready', 'ready']);
    expect(view.gateway.version).toEqual({ state: 'ready', value: '0.1.5' });
    expect(view.accounts.schedulable).toEqual({ state: 'ready', value: 1 });
    expect(view.today.requests).toEqual({ state: 'ready', value: 2 });
    expect(view.today.costUsd).toEqual({ state: 'ready', value: 1.25 });
    expect(view.today.errorRate).toEqual({ state: 'ready', value: 0.5 });
    expect(view.issues).toEqual([]);
  });

  it('keeps independent degraded signals actionable', () => {
    const abnormal: SubscriptionAccountSanitized = {
      ...healthyAccount,
      id: 'claude-2',
      status: 'expired',
      schedulable: false,
      health: 'blocked',
      expiresAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
    };
    const view = buildOverviewModel({
      ...healthySources(),
      gateway: {
        config: source(baseConfig),
        status: source({ ...baseStatus, running: false, port: 0, loopbackUrl: null }),
        keys: source(baseKeys),
        version: source('0.1.5'),
      },
      accounts: source({ ...emptyAccounts, providerAccounts: { ...emptyAccounts.providerAccounts, claude: [abnormal] } }),
      integrations: source({
        ...baseIntegrations,
        integrations: [
          { ...baseIntegrations.integrations[0], status: 'configuration-drift' },
          baseIntegrations.integrations[1],
        ],
      }),
    }, NOW);

    expect(view.pathOperational).toBe(false);
    expect(view.accounts.schedulable).toEqual({ state: 'ready', value: 0 });
    expect(view.issues.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'gatewayStopped',
      'abnormalAccounts',
      'accountsExpiringSoon',
      'integrationCodexNeedsAttention',
    ]));
    expect(view.issues.find((entry) => entry.id === 'gatewayStopped')?.route).toEqual({ page: 'api-service', tab: 'overview' });
    expect(view.issues.find((entry) => entry.id === 'integrationCodexNeedsAttention')?.route).toEqual({ page: 'integrations' });
  });

  it('does not turn missing sources into fabricated zeroes', () => {
    const view = buildOverviewModel({
      gateway: {
        config: unavailable(),
        status: unavailable(),
        keys: unavailable(),
        version: unavailable(),
      },
      accounts: unavailable(),
      allowances: unavailable(),
      usage: unavailable(),
      integrations: unavailable(),
      audit: unavailable(),
    }, NOW);

    expect(view.overallState).toBe('attention');
    expect(view.accounts.schedulable.state).toBe('unavailable');
    expect(view.accounts.schedulable.value).toBeUndefined();
    expect(view.today.requests.state).toBe('unavailable');
    expect(view.today.costUsd.value).toBeUndefined();
    expect(view.gateway.address.state).toBe('unavailable');
    expect(view.stages.map((stage) => stage.state)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable']);
    expect(view.issues.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'gatewayConfigUnavailable',
      'gatewayUnavailable',
      'accessKeyDataUnavailable',
      'accountDataUnavailable',
      'allowanceDataUnavailable',
      'integrationDataUnavailable',
      'usageDataUnavailable',
    ]));
    expect(view.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'noAccessKey' }),
      expect.objectContaining({ id: 'noUpstream' }),
    ]));
  });

  it('surfaces near-limit, stale and integration warnings at their destinations', () => {
    const view = buildOverviewModel({
      ...healthySources(),
      allowances: source([
        {
          ...baseAllowances[0],
          windows: [{ ...baseAllowances[0].windows[0], usedPercent: 92, state: 'fresh' }],
        },
        {
          ...baseAllowances[0],
          accountId: 'claude-2',
          windows: [{ ...baseAllowances[0].windows[0], usedPercent: 75, state: 'stale' }],
        },
      ]),
      integrations: source({
        ...baseIntegrations,
        integrations: [
          baseIntegrations.integrations[0],
          { ...baseIntegrations.integrations[1], status: 'key-missing' },
        ],
      }),
    }, NOW);

    expect(view.allowance.nearLimit).toHaveLength(1);
    expect(view.allowance.stale).toHaveLength(1);
    expect(view.issues.find((entry) => entry.id === 'allowanceNearLimit')?.route).toEqual({ page: 'upstreams', upstreamFilter: 'account' });
    expect(view.issues.find((entry) => entry.id === 'allowanceStale')?.route).toEqual({ page: 'upstreams', upstreamFilter: 'account' });
    expect(view.issues.find((entry) => entry.id === 'integrationClaudeNeedsAttention')?.route).toEqual({ page: 'integrations' });
  });

  it('treats an unobserved Codex allowance as informational, not unavailable', () => {
    const codexAccount: SubscriptionAccountSanitized = {
      ...healthyAccount,
      id: 'codex-1',
      label: 'Codex',
      group: 'codex',
    };
    const view = buildOverviewModel({
      ...healthySources(),
      accounts: source({
        ...emptyAccounts,
        providerAccounts: {
          ...emptyAccounts.providerAccounts,
          claude: [healthyAccount],
          codex: [codexAccount],
        },
      }),
      allowances: source([
        ...baseAllowances,
        {
          providerId: 'codex',
          accountId: 'codex-1',
          source: 'response-headers',
          observedAt: new Date(NOW).toISOString(),
          windows: [],
          lastErrorCode: 'codex_allowance_not_observed',
        },
      ]),
    }, NOW);

    expect(view.allowance.unobservedCount).toBe(1);
    expect(view.allowance.unavailableCount).toBe(0);
    expect(view.issues.find((entry) => entry.id === 'allowanceDataUnavailable')).toBeUndefined();
  });

  it('keeps error rate explicitly unavailable when audit is disabled or incomplete', () => {
    const disabled = buildOverviewModel({
      ...healthySources(),
      audit: unavailable('audit-disabled'),
    }, NOW);
    expect(disabled.today.errorRate).toEqual({ state: 'unavailable' });
    expect(disabled.today.errorRateReason).toBe('audit-disabled');
    expect(disabled.issues.find((entry) => entry.id === 'errorRateUnavailable')?.route).toEqual({ page: 'settings', tab: 'data' });

    const incomplete = buildOverviewModel({
      ...healthySources(),
      audit: source({ ...baseAudit, complete: false }),
    }, NOW);
    expect(incomplete.today.errorRateReason).toBe('audit-incomplete');
    expect(incomplete.issues.find((entry) => entry.id === 'errorRateUnavailable')?.route).toEqual({ page: 'api-service', tab: 'activity' });
  });
});
