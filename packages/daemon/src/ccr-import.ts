/**
 * ccr-import.ts — translate a `claude-code-router` (CCR) `config.json` into an
 * omnicross daemon config (design D9). Pure + testable: `parseCcrConfig(raw)` +
 * `mapCcrToOmnicross(ccr) → { config, notes }`.
 *
 * Provider mapping: CCR `Providers[{name, api_base_url, api_key, models}]` →
 * omnicross provider rows. `apiFormat` is inferred heuristically (default
 * `openai`), with a `notes[]` entry whenever the inference is ambiguous.
 *
 * Router-role mapping (per doc 03 §4.1 / 04 §4.1, user decision 2026-06-03):
 *   default      → default
 *   background   → background
 *   think        → default      (omnicross has no think slot)
 *   longContext  → default      (no longContext slot; `longContextThreshold` dropped)
 *   image        → vision       (CCR's `forceUseImageAgent` dropped)
 *   webSearch    → DROPPED      (philosophically different; recorded as a note)
 *
 * @module @omnicross/daemon/ccr-import
 */

import type { DaemonApiFormat, DaemonConfig, DaemonProviderConfig } from './config';

/** A CCR provider entry (defensive — all fields optional). */
export interface CcrProvider {
  name?: string;
  api_base_url?: string;
  api_key?: string;
  models?: string[];
  transformer?: unknown;
}

/** The CCR `Router` block (a subset; unknown roles are ignored). */
export interface CcrRouter {
  default?: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  image?: string;
  webSearch?: string;
  forceUseImageAgent?: boolean;
}

/** A parsed CCR config. */
export interface CcrConfig {
  Providers?: CcrProvider[];
  Router?: CcrRouter;
}

/** Parse + shape-guard a raw CCR config object. */
export function parseCcrConfig(raw: unknown): CcrConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('CCR config: top-level value must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const Providers = Array.isArray(obj['Providers'])
    ? (obj['Providers'] as CcrProvider[])
    : [];
  const Router =
    obj['Router'] && typeof obj['Router'] === 'object'
      ? (obj['Router'] as CcrRouter)
      : {};
  return { Providers, Router };
}

/**
 * Infer the wire format for a CCR provider from its base URL / name. Returns the
 * inferred format and whether it was an ambiguous (heuristic) guess.
 */
export function inferApiFormat(provider: CcrProvider): {
  format: DaemonApiFormat;
  ambiguous: boolean;
} {
  const hay = `${provider.api_base_url ?? ''} ${provider.name ?? ''}`.toLowerCase();
  if (hay.includes('anthropic') || hay.includes('claude')) {
    return { format: 'anthropic', ambiguous: false };
  }
  if (
    hay.includes('generativelanguage') ||
    hay.includes('gemini') ||
    hay.includes('google')
  ) {
    return { format: 'gemini', ambiguous: false };
  }
  if (hay.includes('openai') || hay.includes('/v1') || hay.includes('chat/completions')) {
    return { format: 'openai', ambiguous: false };
  }
  // Nothing matched → default to openai but flag it.
  return { format: 'openai', ambiguous: true };
}

/** Map CCR Providers → omnicross provider rows, collecting inference notes. */
function mapProviders(
  providers: CcrProvider[],
  notes: string[],
): DaemonProviderConfig[] {
  const rows: DaemonProviderConfig[] = [];
  for (const [i, p] of providers.entries()) {
    const id = p.name?.trim();
    if (!id) {
      notes.push(`Providers[${i}] has no name — skipped.`);
      continue;
    }
    const { format, ambiguous } = inferApiFormat(p);
    if (ambiguous) {
      notes.push(
        `Provider '${id}': could not infer apiFormat from base URL — defaulted to 'openai'. ` +
          `Edit the config if this provider speaks a different wire format.`,
      );
    }
    rows.push({
      id,
      apiFormat: format,
      baseUrl: p.api_base_url ?? '',
      apiKey: p.api_key ?? '',
      models: Array.isArray(p.models) ? p.models : undefined,
    });
  }
  return rows;
}

/** Record the Router-role folds/drops as human-readable notes. */
function noteRouterRoles(router: CcrRouter, notes: string[]): void {
  if (router.think) {
    notes.push(`Router.think → folded into 'default' (omnicross has no think slot).`);
  }
  if (router.longContext) {
    notes.push(
      `Router.longContext → folded into 'default' (no longContext slot; ` +
        `longContextThreshold dropped).`,
    );
  }
  if (router.image) {
    notes.push(`Router.image → mapped to 'vision' (CCR forceUseImageAgent dropped).`);
  }
  if (router.webSearch) {
    notes.push(
      `Router.webSearch → DROPPED. omnicross injects web search via an ` +
        `interception port rather than routing to a natively-online model; ` +
        `the CCR webSearch model ('${router.webSearch}') was not carried over.`,
    );
  }
}

/**
 * Translate a parsed CCR config into a `DaemonConfig` + the list of human-readable
 * notes describing every folded/dropped field. Pure — directly unit-tested.
 */
export function mapCcrToOmnicross(ccr: CcrConfig): {
  config: DaemonConfig;
  notes: string[];
} {
  const notes: string[] = [];
  const providers = mapProviders(ccr.Providers ?? [], notes);
  noteRouterRoles(ccr.Router ?? {}, notes);
  return { config: { providers }, notes };
}
