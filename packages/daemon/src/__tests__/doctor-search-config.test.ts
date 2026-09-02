/**
 * `doctor search` after the 阶段5 assembly: config-first, env as a diagnostic
 * fallback only, and the resolved frontend modes on the report.
 *
 * @module daemon/__tests__/doctor-search-config.test
 */

import { normalizeSearchServerConfig } from '@omnicross/core/outbound-api';
import type { SearchRuntime } from '@omnicross/core/search';
import { describe, expect, it, vi } from 'vitest';

import { resolveSearchApiConfigs, runSearchDoctor } from '../commands/doctor';

const CONFIG_KEY = 'tvly-from-config-not-a-real-key';
const ENV_KEY = 'tvly-from-env-not-a-real-key';
const SEARXNG_HOST = 'https://searx.internal.corp';

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('resolveSearchApiConfigs — config first, env fallback', () => {
  it('lets a configured entry win over the environment variable', () => {
    const resolved = resolveSearchApiConfigs(
      { tavily: { apiKey: CONFIG_KEY } },
      { OMNICROSS_SEARCH_TAVILY_API_KEY: ENV_KEY },
    );

    expect(resolved.tavily).toEqual({ apiKey: CONFIG_KEY });
  });

  it('fills in a provider the config does not name', () => {
    const resolved = resolveSearchApiConfigs(
      { searxng: { apiHost: SEARXNG_HOST } },
      { OMNICROSS_SEARCH_TAVILY_API_KEY: ENV_KEY },
    );

    expect(resolved.tavily).toEqual({ apiKey: ENV_KEY });
    expect(resolved.searxng).toEqual({ apiHost: SEARXNG_HOST });
  });

  it('takes whole entries, not individual fields', () => {
    // The config named tavily with no host; the env's host must NOT be merged
    // in, because a config entry is the operator's statement about a provider.
    const resolved = resolveSearchApiConfigs(
      { tavily: { apiKey: CONFIG_KEY } },
      {
        OMNICROSS_SEARCH_TAVILY_API_KEY: ENV_KEY,
        OMNICROSS_SEARCH_TAVILY_API_HOST: 'https://env.example',
      },
    );

    expect(resolved.tavily).toEqual({ apiKey: CONFIG_KEY });
  });

  it('is the env-only path when there is no config at all', () => {
    expect(resolveSearchApiConfigs(undefined, { OMNICROSS_SEARCH_TAVILY_API_KEY: ENV_KEY }))
      .toEqual({ tavily: { apiKey: ENV_KEY } });
    expect(resolveSearchApiConfigs(undefined, {})).toEqual({});
  });
});

describe('runSearchDoctor with a daemon config', () => {
  it('reports the resolved frontend modes', async () => {
    const capture = captureConsole();
    try {
      await runSearchDoctor(false, {}, {
        config: normalizeSearchServerConfig({
          modes: { codex: 'managed', anthropic: 'off' },
        }),
      });
    } finally {
      capture.restore();
    }

    const modeLine = capture.lines.find((line) => line.includes('frontend modes'));
    expect(modeLine).toContain('codex=managed');
    expect(modeLine).toContain('responses=native');
    expect(modeLine).toContain('anthropic=off');
  });

  it('reports the behavior-preserving defaults when no config is loaded', async () => {
    const capture = captureConsole();
    try {
      await runSearchDoctor(false, {});
    } finally {
      capture.restore();
    }

    expect(capture.lines.find((line) => line.includes('frontend modes')))
      .toContain('codex=off');
  });

  it('shows a config-named provider as configured and the rest as unconfigured', async () => {
    const capture = captureConsole();
    try {
      await runSearchDoctor(false, {}, {
        config: normalizeSearchServerConfig({ providers: { tavily: { apiKey: CONFIG_KEY } } }),
      });
    } finally {
      capture.restore();
    }

    const output = capture.lines.join('\n');
    expect(output).toMatch(/\[.] tavily: source=builtin/);
    expect(output).toContain('jina: source=builtin, kind=api');
    expect(output).toContain('unconfigured');
    // Never a value, from config or from the environment.
    expect(output).not.toContain(CONFIG_KEY);
  });

  it('never prints a configured value, whichever source it came from', async () => {
    const capture = captureConsole();
    try {
      await runSearchDoctor(false, { OMNICROSS_SEARCH_ZHIPU_API_KEY: 'zhipu-env-secret' }, {
        config: normalizeSearchServerConfig({
          providers: {
            tavily: { apiKey: CONFIG_KEY },
            searxng: { apiHost: SEARXNG_HOST, basicAuthPassword: 'searxng-config-secret' },
          },
        }),
      });
    } finally {
      capture.restore();
    }

    const output = capture.lines.join('\n');
    for (const secret of [CONFIG_KEY, ENV_KEY, 'zhipu-env-secret', 'searxng-config-secret', SEARXNG_HOST]) {
      expect(output).not.toContain(secret);
    }
  });

  it('projects the daemon`s own runtime when one is supplied', async () => {
    const runtime: SearchRuntime = {
      search: vi.fn(),
      registerContribution: vi.fn(),
      unregisterContribution: vi.fn(() => false),
      listProviders: vi.fn(() => [
        {
          id: 'host-provider',
          source: 'host',
          kind: 'local-browser',
          capabilities: {
            requiresApiKey: false,
            supportsRegion: true,
            supportsLanguage: true,
            supportsTimeRange: false,
            supportsUrlRead: false,
            supportsCancellation: false,
          },
        },
      ]),
    };
    const capture = captureConsole();
    try {
      await runSearchDoctor(false, {}, { runtime });
    } finally {
      capture.restore();
    }

    const output = capture.lines.join('\n');
    // The report describes what the daemon would actually run, not a rebuilt
    // look-alike: a host contribution the doctor could not have constructed
    // itself shows up because it came from the real runtime.
    expect(runtime.listProviders).toHaveBeenCalled();
    expect(output).toContain('host-provider: source=host, kind=local-browser');
    expect(output).not.toContain('http-bing:');
  });

  it('exits 0 offline and performs no network IO', async () => {
    const capture = captureConsole();
    try {
      await expect(runSearchDoctor(false, {}, {
        config: normalizeSearchServerConfig({ providers: { tavily: { apiKey: CONFIG_KEY } } }),
      })).resolves.toBe(0);
    } finally {
      capture.restore();
    }
  });
});
