/**
 * Daemon search assembly (plan 阶段5 §6.3).
 *
 * Two things matter here and they are both structural: exactly ONE runtime
 * exists per daemon and every consumer holds that same object, and a provider
 * absent from config produces no contribution at all.
 *
 * @module daemon/__tests__/search-assembly.test
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SearchProviderContribution } from '@omnicross/contracts/search-types';
import { normalizeSearchServerConfig } from '@omnicross/core/outbound-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDaemon, resetDaemonSingletonsForTests, type Daemon } from '../bootstrap';
import { loadConfig } from '../config';
import {
  buildSearchRuntime,
  formatSearchEvent,
  searchContributionsFrom,
  searchEgressPolicyFrom,
  searchPolicyFrom,
} from '../search/SearchAssembly';

const TAVILY_KEY = 'tvly-fixture-not-a-real-key';

function config(search?: unknown): ReturnType<typeof normalizeSearchServerConfig> {
  return normalizeSearchServerConfig(search);
}

describe('contribution assembly', () => {
  it('yields only the builtin HTTP pair when nothing is configured', () => {
    const contributions = searchContributionsFrom(config());

    expect(contributions.map((entry) => entry.id)).toEqual(['http-bing', 'http-duckduckgo']);
  });

  it('adds exactly the configured API providers, in registry order', () => {
    const contributions = searchContributionsFrom(config({
      providers: {
        zhipu: { apiKey: 'zhipu-fixture-key' },
        tavily: { apiKey: TAVILY_KEY },
      },
    }));

    expect(contributions.map((entry) => entry.id))
      .toEqual(['http-bing', 'http-duckduckgo', 'tavily', 'zhipu']);
  });

  it('never advertises a provider the config did not name', () => {
    const contributions = searchContributionsFrom(config({
      providers: { tavily: { apiKey: TAVILY_KEY } },
    }));

    for (const absent of ['jina', 'searxng', 'z.ai', 'grok', 'claude', 'exa', 'bocha']) {
      expect(contributions.some((entry) => entry.id === absent), absent).toBe(false);
    }
  });

  it('projects the egress allowlist and the policy knobs verbatim', () => {
    const section = config({
      egress: { allowedPrivateHosts: ['searx.internal.corp'] },
      policy: { preferred: 'tavily', allowed: ['tavily'], fallbackEnabled: false, maxAttempts: 1 },
    });

    expect(searchEgressPolicyFrom(section))
      .toEqual({ allowedPrivateHosts: ['searx.internal.corp'] });
    expect(searchPolicyFrom(section)).toEqual({
      preferred: 'tavily',
      allowed: ['tavily'],
      fallbackEnabled: false,
      maxAttempts: 1,
    });
  });

  it('leaves the egress policy empty (public-only) when no host is allowlisted', () => {
    expect(searchEgressPolicyFrom(config())).toEqual({});
  });
});

describe('buildSearchRuntime', () => {
  it('registers the configured contributions and honors the default policy', async () => {
    const search = vi.fn(async () => [{ title: 'T', url: 'https://example.com/a', content: 'C' }]);
    const contribution: SearchProviderContribution = {
      id: 'stub-provider',
      source: 'host',
      kind: 'api',
      provider: { id: 'stub-provider', search },
      capabilities: {
        requiresApiKey: false,
        supportsRegion: false,
        supportsLanguage: false,
        supportsTimeRange: false,
        supportsUrlRead: false,
        supportsCancellation: true,
      },
    };
    const runtime = buildSearchRuntime(config(), { contributions: [contribution] });

    expect(runtime.listProviders().map((entry) => entry.id)).toEqual(['stub-provider']);
    await expect(runtime.search({ query: 'q' })).resolves.toMatchObject({
      providerId: 'stub-provider',
    });
  });

  it('logs events that carry a query hash and never the query itself', async () => {
    const lines: string[] = [];
    const contribution: SearchProviderContribution = {
      id: 'stub-provider',
      source: 'host',
      kind: 'api',
      provider: {
        id: 'stub-provider',
        search: async () => [
          { title: 'secret-title', url: 'https://intranet.example/x', content: 'confidential' },
        ],
      },
      capabilities: {
        requiresApiKey: false,
        supportsRegion: false,
        supportsLanguage: false,
        supportsTimeRange: false,
        supportsUrlRead: false,
        supportsCancellation: true,
      },
    };
    const runtime = buildSearchRuntime(config(), {
      contributions: [contribution],
      logger: { debug: (message: string) => lines.push(message), warn: () => undefined },
    });

    await runtime.search({ query: 'qqx-distinctive-user-question' });

    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join('\n');
    for (const secret of ['qqx-distinctive', 'secret-title', 'intranet.example', 'confidential']) {
      expect(joined).not.toContain(secret);
    }
    expect(joined).toContain('queryHash=');
  });

  it('formats an event as flat key=value pairs', () => {
    expect(formatSearchEvent({
      type: 'search_complete',
      requestId: 'r1',
      queryHash: 'h1',
      durationMs: 5,
      providerId: 'http-bing',
      resultCount: 2,
      fallbackCount: 0,
    })).toBe(
      'type=search_complete request=r1 queryHash=h1 durationMs=5 provider=http-bing results=2 fallbacks=0',
    );
  });
});

describe('bootstrap threads ONE runtime everywhere', () => {
  let tmpDir: string | undefined;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.providerProxy.stop();
      daemon.apiKeyPool.dispose();
      daemon.tokenRefreshScheduler.dispose();
      daemon.claudeAllowanceRefreshScheduler.dispose();
      daemon.accountHealthSweeper.dispose();
      daemon.accountHealthProbeScheduler.dispose();
      daemon.auditPruneSweeper.dispose();
      daemon.usagePruneSweeper.dispose();
      daemon.billingRetrySweeper.dispose();
      daemon.pricingRefreshScheduler.dispose();
      daemon.routeLeaseManager.shutdown();
      daemon = undefined;
    }
    resetDaemonSingletonsForTests();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  async function boot(search: unknown): Promise<Daemon> {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-search-assembly-'));
    const configPath = join(tmpDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      providers: [],
      server: { enabled: false, networkBinding: false, port: 0, endpoints: [], search },
    }), 'utf8');
    const built = buildDaemon(loadConfig(configPath), {
      configPath,
      keysPath: join(tmpDir, 'keys.json'),
      tokensPath: join(tmpDir, 'tokens.json'),
      masterKeyFilePath: join(tmpDir, 'master.key'),
    });
    await built.llmConfig.ready();
    daemon = built;
    return built;
  }

  it('shares one runtime instance with the proxy deps and the outbound server', async () => {
    const built = await boot({ providers: { tavily: { apiKey: TAVILY_KEY } } });

    expect(built.searchRuntime).toBeDefined();
    // Same object, not an equal one: a second runtime is a second provider
    // order, which is exactly what the extraction removes.
    expect(built.providerProxy.getDeps().searchRuntime).toBe(built.searchRuntime);
  });

  it('reflects the configured providers in discovery, and nothing else', async () => {
    const built = await boot({ providers: { tavily: { apiKey: TAVILY_KEY } } });

    expect(built.searchRuntime.listProviders().map((entry) => entry.id))
      .toEqual(['http-bing', 'http-duckduckgo', 'tavily']);
  });

  it('carries the configured frontend modes through to the proxy deps', async () => {
    const built = await boot({ modes: { codex: 'managed', anthropic: 'managed' } });

    expect(built.searchFrontendModes)
      .toEqual({ codex: 'managed', responses: 'native', anthropic: 'managed' });
    expect(built.providerProxy.getDeps().searchFrontendModes).toBe(built.searchFrontendModes);
  });

  it('defaults to HTTP-only providers and behavior-preserving modes with no section', async () => {
    const built = await boot(undefined);

    expect(built.searchRuntime.listProviders().map((entry) => entry.id))
      .toEqual(['http-bing', 'http-duckduckgo']);
    expect(built.searchFrontendModes)
      .toEqual({ codex: 'off', responses: 'native', anthropic: 'native' });
  });

  it('boots with an invalid section instead of crashing', async () => {
    const built = await boot({ modes: { responses: 'nonsense' }, providers: { tavily: {} } });

    expect(built.searchRuntime.listProviders().map((entry) => entry.id))
      .toEqual(['http-bing', 'http-duckduckgo']);
    expect(built.searchFrontendModes.responses).toBe('native');
  });
});
