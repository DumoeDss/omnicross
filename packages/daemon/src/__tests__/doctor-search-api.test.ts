/**
 * `doctor search` over the keyed API providers (plan 阶段4).
 *
 * A separate file from `doctor-search.test.ts` on purpose: the 阶段2 doctor
 * suite stays byte-identical, so "the existing behavior is unchanged" is
 * evidence rather than a claim.
 *
 * Nothing here performs network IO. The live path is asserted structurally —
 * which providers WOULD be probed — because probing for real would send a query
 * to a third-party API from a unit test.
 *
 * @module __tests__/doctor-search-api.test
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SearchProviderError } from '@omnicross/contracts/search-types';
import { apiSearchContributions } from '@omnicross/core/search/api';
import { builtinHttpSearchContributions } from '@omnicross/core/search/http';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchDoctorSnapshot,
  classifyLiveSearchOutcome,
  readSearchApiConfigFromEnv,
  runSearchDoctor,
} from '../commands/doctor';

const CHECKED_AT = '2026-09-02T00:00:00.000Z';

/** A realistic-looking value that must never appear in any output. */
const CANARY_KEY = 'tvly-DOCTORCANARY-0123456789abcdef';
const CANARY_HOST = 'https://tavily.private-mirror.example.test';

function captureInfo(run: () => Promise<number> | number): Promise<{ output: string; code: number }> {
  const lines: string[] = [];
  const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  return Promise.resolve(run())
    .then((code) => ({ output: lines.join('\n'), code }))
    .finally(() => info.mockRestore());
}

describe('buildSearchDoctorSnapshot — unconfigured API rows', () => {
  it('keeps its 阶段2 behavior when no API config is supplied', () => {
    // The second parameter is what opts in; omitting it must project exactly
    // what was handed in, as before.
    expect(buildSearchDoctorSnapshot()).toHaveLength(2);
    expect(buildSearchDoctorSnapshot().every((row) => row.status === undefined)).toBe(true);
  });

  it('lists all five API providers as unconfigured when nothing is configured', () => {
    const rows = buildSearchDoctorSnapshot(builtinHttpSearchContributions(), {});
    const apiRows = rows.filter((row) => row.kind === 'api');

    expect(apiRows.map((row) => row.providerId)).toEqual([
      'tavily',
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ]);
    for (const row of apiRows) {
      expect(row.status).toBe('unconfigured');
      expect(row.reason).toBeTruthy();
      expect(row.source).toBe('builtin');
    }
    // The two HTTP rows are untouched and carry no status.
    expect(rows.filter((row) => row.kind === 'http')).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'http').every((row) => !row.status)).toBe(true);
  });

  it('names what is missing per provider, not what is present', () => {
    const rows = buildSearchDoctorSnapshot([], {});
    const reason = (id: string): string =>
      rows.find((row) => row.providerId === id)?.reason ?? '';

    expect(reason('tavily')).toContain('API key');
    expect(reason('searxng')).toContain('API host');
    // Jina's asymmetry is stated rather than glossed: keyless is possible, but
    // still has to be asked for.
    expect(reason('jina')).toContain('without a key');
  });

  it('drops a provider from the unconfigured list once it is configured', () => {
    const configs = { tavily: { apiKey: CANARY_KEY } };
    const rows = buildSearchDoctorSnapshot(apiSearchContributions(configs), configs);

    const tavily = rows.filter((row) => row.providerId === 'tavily');
    expect(tavily).toHaveLength(1);
    expect(tavily[0].status).toBeUndefined();
    expect(rows.filter((row) => row.status === 'unconfigured').map((row) => row.providerId)).toEqual([
      'jina',
      'searxng',
      'zhipu',
      'z.ai',
    ]);
  });

  it('reports declared capabilities on unconfigured rows too', () => {
    const rows = buildSearchDoctorSnapshot([], {});
    const byId = (id: string): (typeof rows)[number] =>
      rows.find((row) => row.providerId === id)!;

    expect(byId('tavily').capabilities.requiresApiKey).toBe(true);
    expect(byId('jina').capabilities.supportsUrlRead).toBe(true);
    expect(byId('searxng').capabilities.requiresApiKey).toBe(false);
  });
});

describe('readSearchApiConfigFromEnv — the diagnostic-only convenience', () => {
  it('reads nothing from an empty environment', () => {
    expect(readSearchApiConfigFromEnv({})).toEqual({});
  });

  it('maps each documented variable onto its provider', () => {
    const configs = readSearchApiConfigFromEnv({
      OMNICROSS_SEARCH_TAVILY_API_KEY: 'tk',
      OMNICROSS_SEARCH_TAVILY_API_HOST: 'https://tavily.example.test',
      OMNICROSS_SEARCH_JINA_API_KEY: 'jk',
      OMNICROSS_SEARCH_SEARXNG_API_HOST: 'https://searx.example.test',
      OMNICROSS_SEARCH_SEARXNG_BASIC_AUTH_USERNAME: 'user',
      OMNICROSS_SEARCH_SEARXNG_BASIC_AUTH_PASSWORD: 'pass',
      OMNICROSS_SEARCH_ZHIPU_API_KEY: 'zk',
      // A dot is not valid in an environment variable name.
      OMNICROSS_SEARCH_Z_AI_API_KEY: 'zaik',
    });

    expect(configs).toEqual({
      tavily: { apiKey: 'tk', apiHost: 'https://tavily.example.test' },
      jina: { apiKey: 'jk' },
      searxng: {
        apiHost: 'https://searx.example.test',
        basicAuthUsername: 'user',
        basicAuthPassword: 'pass',
      },
      zhipu: { apiKey: 'zk' },
      'z.ai': { apiKey: 'zaik' },
    });
  });

  it('treats empty and whitespace-only values as absent', () => {
    expect(
      readSearchApiConfigFromEnv({
        OMNICROSS_SEARCH_TAVILY_API_KEY: '',
        OMNICROSS_SEARCH_ZHIPU_API_KEY: '   ',
      }),
    ).toEqual({});
  });

  it('enables Jina from a host alone, since it runs keyless', () => {
    expect(readSearchApiConfigFromEnv({ OMNICROSS_SEARCH_JINA_API_HOST: 'https://s.example.test' })).toEqual(
      { jina: { apiHost: 'https://s.example.test' } },
    );
  });

  it('ignores a SearXNG basic-auth pair with no host to attach it to', () => {
    expect(
      readSearchApiConfigFromEnv({
        OMNICROSS_SEARCH_SEARXNG_BASIC_AUTH_USERNAME: 'user',
        OMNICROSS_SEARCH_SEARXNG_BASIC_AUTH_PASSWORD: 'pass',
      }),
    ).toEqual({});
  });
});

describe('Live probe gating and classification', () => {
  it('probes exactly the configured providers — an unconfigured one is not in the set', () => {
    const withKey = readSearchApiConfigFromEnv({ OMNICROSS_SEARCH_TAVILY_API_KEY: CANARY_KEY });
    expect(apiSearchContributions(withKey).map((contribution) => contribution.id)).toEqual(['tavily']);

    // Unsetting the variable returns tavily to unconfigured, with nothing to probe.
    const without = readSearchApiConfigFromEnv({});
    expect(apiSearchContributions(without)).toEqual([]);
    expect(
      buildSearchDoctorSnapshot([], without).find((row) => row.providerId === 'tavily')?.status,
    ).toBe('unconfigured');
  });

  it('classifies an egress denial as blocked, not failed', () => {
    const denied = classifyLiveSearchOutcome(
      'searxng',
      { kind: 'failure', error: new SearchProviderError('policy_denied', 'egress policy denied host "10.0.0.2"') },
      CHECKED_AT,
    );

    expect(denied.status).toBe('blocked');
    expect(denied.error?.code).toBe('policy_denied');
    expect(denied.reason).toContain('egress policy');
  });

  it('classifies keyed failures as failed with their code visible', () => {
    for (const code of ['auth_failed', 'rate_limited'] as const) {
      const diagnostic = classifyLiveSearchOutcome(
        'tavily',
        { kind: 'failure', error: new SearchProviderError(code, `upstream said ${code}`) },
        CHECKED_AT,
      );
      expect(diagnostic.status).toBe('failed');
      expect(diagnostic.error?.code).toBe(code);
    }
  });
});

describe('runSearchDoctor output hygiene', () => {
  it('prints unconfigured rows, exits 0, and performs no network IO', async () => {
    const { output, code } = await captureInfo(() => runSearchDoctor(false, {}));

    expect(code).toBe(0);
    for (const id of ['tavily', 'jina', 'searxng', 'zhipu', 'z.ai']) {
      expect(output).toContain(id);
    }
    expect(output).toContain('unconfigured');
    expect(output).toContain('http-bing');
  });

  it('never echoes a configured key or host', async () => {
    const { output } = await captureInfo(() =>
      runSearchDoctor(false, {
        OMNICROSS_SEARCH_TAVILY_API_KEY: CANARY_KEY,
        OMNICROSS_SEARCH_TAVILY_API_HOST: CANARY_HOST,
        OMNICROSS_SEARCH_SEARXNG_API_HOST: 'https://searx.private.example.test',
        OMNICROSS_SEARCH_SEARXNG_BASIC_AUTH_PASSWORD: 'doctor-canary-password',
      }),
    );

    for (const secret of [
      CANARY_KEY,
      CANARY_HOST,
      'DOCTORCANARY',
      'searx.private.example.test',
      'doctor-canary-password',
    ]) {
      expect(output).not.toContain(secret);
    }
    // The row itself is still there — it is the VALUES that are absent.
    expect(output).toContain('tavily');
    expect(output).not.toMatch(/tavily.*unconfigured/);
  });
});

describe('The env convenience is confined to the doctor command', () => {
  const DAEMON_SRC = new URL('../', import.meta.url);
  const CORE_SEARCH = new URL('../../../core/src/search/', import.meta.url);

  function readTree(root: URL, subdirectory = ''): Array<{ path: string; source: string }> {
    const base = new URL(subdirectory, root);
    return readdirSync(fileURLToPath(base), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${subdirectory}${entry.name}`;
      if (entry.isDirectory()) return readTree(root, `${relative}/`);
      if (!entry.name.endsWith('.ts')) return [];
      // Resolved against `root`, not `base`: `relative` already carries the
      // subdirectory prefix.
      return [{ path: relative, source: readFileSync(fileURLToPath(new URL(relative, root)), 'utf8') }];
    });
  }

  it('reads OMNICROSS_SEARCH_* only inside the doctor command path', () => {
    const files = readTree(DAEMON_SRC);
    expect(files.length).toBeGreaterThan(10);

    const readers = files
      .filter((file) => file.source.includes('OMNICROSS_SEARCH_'))
      .map((file) => file.path);

    // The command itself, its usage text, and the two suites that exercise the
    // convenience. 阶段5 demoted it to a FALLBACK behind the daemon `search`
    // config section, but did not widen where it may be read.
    expect(readers.sort()).toEqual([
      '__tests__/doctor-search-api.test.ts',
      '__tests__/doctor-search-config.test.ts',
      'cli.ts',
      'commands/doctor.ts',
    ]);
  });

  it('leaves the search runtime reading no environment at all beyond proxy settings', () => {
    const files = readTree(CORE_SEARCH).filter(
      (file) => !file.path.includes('__tests__') && file.path !== 'http/proxy.ts',
    );
    expect(files.length).toBeGreaterThan(15);

    for (const file of files) {
      // Comments are stripped first: several modules DOCUMENT that their `env`
      // parameter defaults to `process.env` further down the call chain, and a
      // prose match would fail on the documentation rather than on a read.
      const code = file.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // `apiSearchContributions` and the adapters take configuration as
      // arguments. Only `http/proxy.ts` reads the environment, and only for the
      // conventional proxy variables it has always read.
      expect(code, `${file.path} must not read process.env`).not.toContain('process.env');
      expect(code, `${file.path} must not read OMNICROSS_SEARCH_*`).not.toContain(
        'OMNICROSS_SEARCH_',
      );
    }
  });
});
