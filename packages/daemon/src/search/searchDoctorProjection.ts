/**
 * searchDoctorProjection — the PURE search-doctor vocabulary (search-settings-ui).
 *
 * Everything here was originally part of `commands/doctor.ts`; the admin search
 * surface needs the same classification, but importing the CLI command would
 * drag `buildDaemon` (the whole bootstrap graph) into the admin router — a
 * cycle. So the pure, IO-free projection moved to this leaf module beside
 * `SearchAssembly`, and the command re-exports it for its existing importers.
 *
 * Deliberately NOT moved: `readSearchApiConfigFromEnv` /
 * `resolveSearchApiConfigs`. The doctor's diagnostic environment convenience is
 * pinned by test to the doctor command path only (`commands/doctor.ts` +
 * `cli.ts`), and the admin surface reads the PERSISTED config, never the
 * environment.
 *
 * @module @omnicross/daemon/search/searchDoctorProjection
 */

import { toSearchErrorShape } from '@omnicross/contracts/search-types';
import type {
  SearchProviderCapabilities,
  SearchProviderContribution,
  SearchProviderDiagnostic,
  SearchProviderHealthStatus,
  SearchProviderId,
  SearchProviderSource,
  SearchTransportKind,
} from '@omnicross/contracts/search-types';
import {
  JINA_CAPABILITIES,
  SEARXNG_CAPABILITIES,
  TAVILY_CAPABILITIES,
  ZHIPU_CAPABILITIES,
  type SearchApiProviderConfigs,
} from '@omnicross/core/search/api';
import { builtinHttpSearchContributions } from '@omnicross/core/search/http';

/**
 * What the snapshot needs from a provider: what it DECLARES, nothing more.
 *
 * Both `SearchProviderContribution` and the runtime's
 * `SearchProviderDescriptor` satisfy it, so the doctor can project either
 * without a converter and without ever touching a provider instance.
 */
export interface SearchProviderDeclaration {
  readonly id: SearchProviderId;
  readonly source: SearchProviderSource;
  readonly kind: SearchTransportKind;
  readonly capabilities: SearchProviderCapabilities;
}

/** One row of the offline search-doctor snapshot. */
export interface SearchDoctorRow {
  providerId: SearchProviderId;
  source: SearchProviderSource;
  kind: SearchTransportKind;
  capabilities: SearchProviderCapabilities;
  /** Offline-determinable status. Present only on `unconfigured` rows. */
  status?: SearchProviderHealthStatus;
  /** What is missing, for an `unconfigured` row. Never echoes a value. */
  reason?: string;
}

/**
 * Every API provider the search doctor knows how to report on, with the
 * offline-determinable answer to "is this configured?".
 *
 * `requires` is the setting whose ABSENCE makes the provider unconfigured. It
 * is a predicate over the config, never a value read out of it: no part of this
 * table ever touches a key or a host string.
 */
const API_DOCTOR_PROVIDERS: ReadonlyArray<{
  id: SearchProviderId;
  capabilities: SearchProviderCapabilities;
  configured: (configs: SearchApiProviderConfigs) => boolean;
  missingReason: string;
}> = [
  {
    id: 'tavily',
    capabilities: TAVILY_CAPABILITIES,
    configured: (configs) => configs.tavily !== undefined,
    missingReason: 'no API key configured',
  },
  {
    id: 'jina',
    capabilities: JINA_CAPABILITIES,
    configured: (configs) => configs.jina !== undefined,
    // Honest about the asymmetry: Jina CAN run keyless, but a provider nobody
    // asked for is still not enabled.
    missingReason: 'not configured (Jina can run without a key, but must be enabled explicitly)',
  },
  {
    id: 'searxng',
    capabilities: SEARXNG_CAPABILITIES,
    configured: (configs) => configs.searxng !== undefined,
    missingReason: 'no API host configured',
  },
  {
    id: 'zhipu',
    capabilities: ZHIPU_CAPABILITIES,
    configured: (configs) => configs.zhipu !== undefined,
    missingReason: 'no API key configured',
  },
  {
    id: 'z.ai',
    capabilities: ZHIPU_CAPABILITIES,
    configured: (configs) => configs['z.ai'] !== undefined,
    missingReason: 'no API key configured',
  },
];

/**
 * Project search contributions into a printable snapshot.
 *
 * Pure and IO-free: it reads what the contributions DECLARE (`source`, `kind`,
 * capabilities) and infers nothing from a provider id's spelling.
 *
 * Pass `apiConfigs` to also list the API providers that are NOT configured —
 * the first real use of the `unconfigured` status. Omit it and the function
 * projects what it is handed, nothing more.
 */
export function buildSearchDoctorSnapshot(
  // Accepts contributions OR the runtime's own `listProviders()` descriptors —
  // the two shapes agree on exactly these four fields, which lets the
  // config-first path project the REAL assembled runtime rather than a second
  // contribution set built to look like it.
  contributions: ReadonlyArray<SearchProviderDeclaration> = builtinHttpSearchContributions(),
  apiConfigs?: SearchApiProviderConfigs,
): SearchDoctorRow[] {
  const rows: SearchDoctorRow[] = contributions.map((contribution) => ({
    providerId: contribution.id,
    source: contribution.source,
    kind: contribution.kind,
    capabilities: contribution.capabilities,
  }));

  if (apiConfigs === undefined) return rows;

  for (const provider of API_DOCTOR_PROVIDERS) {
    if (provider.configured(apiConfigs)) continue;
    rows.push({
      providerId: provider.id,
      source: 'builtin',
      kind: 'api',
      capabilities: provider.capabilities,
      status: 'unconfigured',
      reason: provider.missingReason,
    });
  }
  return rows;
}

/**
 * The one fixed query a live check sends.
 *
 * Public, low-sensitivity, and committed in the fixture README — the live
 * check must never send a user's query.
 *
 * Changed 2026-09-04 from `mozilla developer network http headers`: cn.bing.com
 * brand-interprets THAT string into Mozilla-organization pages the anti-decoy
 * check refuses, so a healthy provider reported `blocked` on CN egress. The
 * replacement is one both engines answer with on-topic MDN results that PASS
 * the trust check (verified live, Bing and DuckDuckGo, impit and undici).
 */
export const SEARCH_DOCTOR_QUERY = 'MDN HTTP headers documentation';

/** What one live provider check produced. */
export type LiveSearchOutcome =
  | { kind: 'results'; count: number }
  | { kind: 'failure'; error: unknown };

/**
 * Map a live outcome onto the five diagnostic statuses. Pure — no clock, no
 * network, no IO — so the whole table is unit-testable.
 */
export function classifyLiveSearchOutcome(
  providerId: SearchProviderId,
  outcome: LiveSearchOutcome,
  checkedAt: string,
): SearchProviderDiagnostic {
  if (outcome.kind === 'results') {
    if (outcome.count > 0) return { providerId, status: 'healthy', checkedAt };
    // A recognized SERP with zero results. There is NO error here — inventing
    // one would recreate exactly the empty-vs-parser-failure conflation this
    // slice exists to remove — so the diagnostic carries a reason only.
    return {
      providerId,
      status: 'degraded',
      checkedAt,
      reason: 'reachable, but the engine returned no usable results (possible partial drift)',
    };
  }

  const error = toSearchErrorShape(outcome.error);
  const stage = error.details?.stage;
  const { status, reason } = classifySearchFailure(stage, error.code);
  return { providerId, status, checkedAt, reason, error };
}

function classifySearchFailure(
  stage: string | undefined,
  code: string,
): { status: SearchProviderHealthStatus; reason: string } {
  // Challenge and trust are network/engine verdicts about US, not breakage:
  // a different egress path may well succeed, so they are `blocked`.
  if (stage === 'challenge') {
    return { status: 'blocked', reason: 'the engine served a bot challenge instead of results' };
  }
  if (stage === 'trust') {
    return {
      status: 'blocked',
      reason: 'the engine served a page that failed the anti-decoy trust check',
    };
  }
  // Like challenge/trust, an egress denial is a verdict about the request we
  // were willing to make, not about the provider being broken.
  if (code === 'policy_denied') {
    return {
      status: 'blocked',
      reason: 'the egress policy refused the request target',
    };
  }
  if (code === 'parse_failed') {
    return {
      status: 'failed',
      reason: 'the response was not recognizable as a search result page (parser drift suspected)',
    };
  }
  if (code === 'timeout') {
    return { status: 'failed', reason: 'the request exceeded its time budget' };
  }
  return { status: 'failed', reason: `the request failed (${code})` };
}

/** Run the fixed query once per provider, classifying whatever comes back. */
export async function runSearchLiveChecks(
  contributions: SearchProviderContribution[],
  now: () => string = () => new Date().toISOString(),
): Promise<SearchProviderDiagnostic[]> {
  const diagnostics: SearchProviderDiagnostic[] = [];
  for (const contribution of contributions) {
    try {
      const results = await contribution.provider.search(SEARCH_DOCTOR_QUERY, { maxResults: 5 });
      diagnostics.push(
        classifyLiveSearchOutcome(contribution.id, { kind: 'results', count: results.length }, now()),
      );
    } catch (error) {
      diagnostics.push(classifyLiveSearchOutcome(contribution.id, { kind: 'failure', error }, now()));
    }
  }
  return diagnostics;
}
