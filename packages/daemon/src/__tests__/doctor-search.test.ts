/**
 * Tests for `omnicross doctor search`: the pure offline snapshot and the pure
 * live-outcome classification table. No network in either direction — the live
 * path is exercised through providers built on a stub transport.
 *
 * @module daemon/__tests__/doctor-search.test
 */

import { SearchProviderError, type SearchProviderContribution } from '@omnicross/contracts/search-types';
import { builtinHttpSearchContributions } from '@omnicross/core/search/http';
import type { SearchHttpTransport } from '@omnicross/core/search/http';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSearchDoctorSnapshot,
  classifyLiveSearchOutcome,
  runDoctor,
  runSearchLiveChecks,
  SEARCH_DOCTOR_QUERY,
} from '../commands/doctor';

const CHECKED_AT = '2026-09-01T00:00:00.000Z';

function searchError(
  code: ConstructorParameters<typeof SearchProviderError>[0],
  stage: string,
): SearchProviderError {
  return new SearchProviderError(code, 'sanitized message', {
    providerId: 'http-bing',
    details: { transport: 'undici', stage },
  });
}

describe('buildSearchDoctorSnapshot (pure, no IO)', () => {
  it('lists both builtin providers with their declared source, kind and capabilities', () => {
    const snapshot = buildSearchDoctorSnapshot();

    expect(snapshot.map((row) => row.providerId)).toEqual(['http-bing', 'http-duckduckgo']);
    for (const row of snapshot) {
      expect(row.source).toBe('builtin');
      expect(row.kind).toBe('http');
      expect(row.capabilities.requiresApiKey).toBe(false);
      expect(row.capabilities.supportsCancellation).toBe(true);
      expect(row.capabilities.maxResults).toBe(10);
    }
  });

  it('projects whatever contributions it is handed, inferring nothing from the id', () => {
    const contribution = {
      id: 'local-something',
      source: 'host',
      kind: 'local-browser',
      provider: { id: 'local-something', search: async () => [] },
      capabilities: {
        requiresApiKey: true,
        supportsRegion: true,
        supportsLanguage: true,
        supportsTimeRange: true,
        supportsUrlRead: true,
        supportsCancellation: false,
      },
    } satisfies SearchProviderContribution;

    expect(buildSearchDoctorSnapshot([contribution])).toEqual([
      {
        providerId: 'local-something',
        source: 'host',
        kind: 'local-browser',
        capabilities: contribution.capabilities,
      },
    ]);
  });
});

describe('classifyLiveSearchOutcome (pure and total)', () => {
  it('maps every outcome class onto the documented status', () => {
    const cases: Array<[string, Parameters<typeof classifyLiveSearchOutcome>[1], string]> = [
      ['results', { kind: 'results', count: 3 }, 'healthy'],
      ['empty', { kind: 'results', count: 0 }, 'degraded'],
      ['challenge', { kind: 'failure', error: searchError('upstream_unavailable', 'challenge') }, 'blocked'],
      ['trust', { kind: 'failure', error: searchError('upstream_unavailable', 'trust') }, 'blocked'],
      ['parse_failed', { kind: 'failure', error: searchError('parse_failed', 'parse') }, 'failed'],
      ['timeout', { kind: 'failure', error: searchError('timeout', 'fetch') }, 'failed'],
      ['connect', { kind: 'failure', error: searchError('upstream_unavailable', 'connect') }, 'failed'],
    ];

    for (const [label, outcome, expected] of cases) {
      const diagnostic = classifyLiveSearchOutcome('http-bing', outcome, CHECKED_AT);
      expect(diagnostic.status, label).toBe(expected);
      expect(diagnostic.providerId).toBe('http-bing');
      expect(diagnostic.checkedAt).toBe(CHECKED_AT);
    }
  });

  it('carries the sanitized error shape, with transport and stage, on every failure', () => {
    for (const stage of ['challenge', 'trust', 'parse', 'connect', 'fetch']) {
      const diagnostic = classifyLiveSearchOutcome(
        'http-duckduckgo',
        { kind: 'failure', error: searchError('upstream_unavailable', stage) },
        CHECKED_AT,
      );
      expect(diagnostic.error?.details?.transport).toBe('undici');
      expect(diagnostic.error?.details?.stage).toBe(stage);
      expect(diagnostic.reason).toBeTruthy();
    }
  });

  it('reports a recognized-empty result as degraded WITHOUT fabricating an error', () => {
    const diagnostic = classifyLiveSearchOutcome('http-bing', { kind: 'results', count: 0 }, CHECKED_AT);

    expect(diagnostic.status).toBe('degraded');
    // Nothing failed, so there is no error shape to carry. Synthesizing one
    // would re-conflate "found nothing" with "could not parse" — the exact
    // distinction this slice was built to make.
    expect(diagnostic.error).toBeUndefined();
    expect(diagnostic.reason).toContain('no usable results');
  });

  it('classifies a non-taxonomy throw through the contract default', () => {
    const diagnostic = classifyLiveSearchOutcome(
      'http-bing',
      { kind: 'failure', error: new Error('something unexpected') },
      CHECKED_AT,
    );

    expect(diagnostic.status).toBe('failed');
    expect(diagnostic.error?.code).toBe('upstream_unavailable');
  });
});

describe('runSearchLiveChecks', () => {
  it('sends exactly one fixed query per provider and classifies each independently', async () => {
    const queries: string[] = [];
    const transport: SearchHttpTransport = async (url, request) => {
      queries.push(new URL(url).searchParams.get('q') ?? '');
      if (url.includes('bing.com')) {
        throw new SearchProviderError('parse_failed', 'unrecognizable', {
          providerId: request.providerId,
          details: { transport: 'undici', stage: 'parse' },
        });
      }
      return {
        finalUrl: url,
        status: 200,
        contentType: 'text/html',
        rawText:
          '<html><body><div id="links" class="results">' +
          '<div class="result"><a class="result__a" href="https://example.test/a">A result</a>' +
          '<div class="result__snippet">snippet</div></div></div></body></html>',
      };
    };

    const diagnostics = await runSearchLiveChecks(
      builtinHttpSearchContributions(transport),
      () => CHECKED_AT,
    );

    expect(queries).toEqual([SEARCH_DOCTOR_QUERY, SEARCH_DOCTOR_QUERY]);
    expect(diagnostics.map((d) => [d.providerId, d.status])).toEqual([
      ['http-bing', 'failed'],
      ['http-duckduckgo', 'healthy'],
    ]);
    expect(diagnostics[1].error).toBeUndefined();
  });
});

describe('runDoctor search subcommand', () => {
  it('prints the offline snapshot, exits 0, and performs no network call', async () => {
    const lines: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    const fetchImpl = vi.fn();

    try {
      expect(await runDoctor(['search'], fetchImpl as unknown as typeof fetch)).toBe(0);
    } finally {
      info.mockRestore();
    }

    const output = lines.join('\n');
    expect(output).toContain('http-bing');
    expect(output).toContain('http-duckduckgo');
    expect(output).toContain('source=builtin');
    expect(output).toContain('kind=http');
    expect(output).toContain('maxResults=10');
    expect(fetchImpl).not.toHaveBeenCalled();
    // Offline mode must not require the config every other subject demands.
    expect(output).not.toContain('--config');
  });

  it('still rejects an unknown subject, and names search as supported', async () => {
    await expect(runDoctor(['bogus'])).rejects.toThrow(/supported: 'claude', 'images', 'search'/);
  });
});
