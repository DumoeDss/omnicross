/**
 * antigravityIdentity — the Antigravity client's masquerade identity (UA
 * version hot-probe + per-wire-id request profiles).
 *
 * The Antigravity backend gates newer models on the client version carried by
 * the `User-Agent`. The exact shape, captured from the real `antigravity/hub`
 * client:
 *
 *   antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)
 *
 * Resolution ladder for the version (three layers, task D4):
 *   1. `ANTIGRAVITY_VERSION` env — when set, the manifest probe is SKIPPED
 *      entirely and the env value wins,
 *   2. the official electron-builder update manifest, cached for one hour with
 *      a 5s timeout (in-flight calls share the single probe),
 *   3. the pinned fallback `2.8.0` (any probe failure — timeout, non-200,
 *      unparseable body — silently keeps this valid).
 *
 * The probe NEVER blocks a caller: `ensureAntigravityVersion()` is fire- and
 * forget-able; every consumer reads `getAntigravityUserAgent()` synchronously,
 * which falls back to the pinned version until a probe succeeds. `os_type` /
 * `arch` are pinned to the darwin/arm64 reference client the wire constants
 * were captured from (the backend does not validate `cl`).
 *
 * Env escape hatches: `ANTIGRAVITY_VERSION` / `ANTIGRAVITY_CL` /
 * `ANTIGRAVITY_OS` / `ANTIGRAVITY_ARCH`. Any override suppresses automatic
 * version discovery while the other fields retain their pinned defaults.
 *
 * @module transformer/transformers/antigravityIdentity
 */

import { fetchUpstream } from '../../pipeline/upstreamFetch';

/** The offline/pinned fallback version (captured from the reference client). */
export const DEFAULT_ANTIGRAVITY_VERSION = '2.8.0';

const ANTIGRAVITY_VERSION_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;

/** Injectable fetch for the manifest probe (tests inject a fake transport). */
export type AntigravityVersionFetcher = (url: string, init?: RequestInit) => Promise<Response>;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;
let nextVersionProbeAt = 0;

/** Test seam — drop the discovered version + in-flight probe. */
export function __resetAntigravityVersionCache(): void {
  discoveredAntigravityVersion = null;
  antigravityVersionFetch = null;
  nextVersionProbeAt = 0;
}

/** Current version: env override → manifest-discovered → pinned fallback. */
export function getAntigravityVersion(): string {
  return process.env['ANTIGRAVITY_VERSION'] || discoveredAntigravityVersion || DEFAULT_ANTIGRAVITY_VERSION;
}

/**
 * Extract the client version from an electron-builder update manifest (YAML).
 * Returns `null` when no well-formed `version:` line is present. Pure.
 */
export function parseAntigravityManifestVersion(yamlText: string): string | null {
  for (const line of yamlText.split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/**
 * Resolve the latest version from the official update manifest. Success is
 * cached for one hour; failures retain the last known version (or the pin)
 * and back off for one minute. Explicit identity overrides skip the probe.
 * Never rejects.
 */
export function ensureAntigravityVersion(
  fetcher: AntigravityVersionFetcher = (url, init) => fetchUpstream(url, init ?? {}, { providerId: 'antigravity', redactBodies: true }),
  signal?: AbortSignal,
): Promise<void> {
  if (['ANTIGRAVITY_VERSION', 'ANTIGRAVITY_CL', 'ANTIGRAVITY_OS', 'ANTIGRAVITY_ARCH']
    .some((key) => process.env[key])) return Promise.resolve();
  if (antigravityVersionFetch) return antigravityVersionFetch;
  if (Date.now() < nextVersionProbeAt) return Promise.resolve();
  nextVersionProbeAt = Date.now() + 60_000;

  antigravityVersionFetch = (async () => {
    try {
      const timeoutSignal = AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);
      const response = await fetcher(ANTIGRAVITY_VERSION_MANIFEST_URL, {
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'electron-builder' },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.ok) {
        const version = parseAntigravityManifestVersion(await response.text());
        if (version) {
          discoveredAntigravityVersion = version;
          nextVersionProbeAt = Date.now() + 60 * 60_000;
        }
      }
    } catch {
      // Silent: the pinned fallback remains valid when version discovery fails.
    } finally {
      antigravityVersionFetch = null;
    }
  })();
  return antigravityVersionFetch;
}

/**
 * The Antigravity `User-Agent` value. `cl` is not validated by the backend
 * (only the version gates), so the captured constant stands unless overridden.
 */
export function getAntigravityUserAgent(): string {
  const version = getAntigravityVersion();
  const cl = process.env['ANTIGRAVITY_CL'] || '963137146';
  const os = process.env['ANTIGRAVITY_OS'] || 'darwin';
  const arch = process.env['ANTIGRAVITY_ARCH'] || 'arm64';
  return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

/**
 * Per-wire-id Antigravity CCA request constants, captured from the reference
 * client against `daily-cloudcode-pa`:
 *  - `modelEnum` is the opaque `labels.model_enum` telemetry token — OPTIONAL
 *    because Anthropic-backed wire ids are accepted without one,
 *  - `maxOutputTokens` is the fixed `generationConfig.maxOutputTokens` the
 *    backend enforces regardless of the thinking budget (Claude caps at
 *    64000 — a larger value is a 400; Gemini ids take the discovered cap).
 *
 * Keyed by the routed upstream WIRE id (post effort/thinking variant mapping),
 * not the logical id. Ids without an entry keep the request's own value.
 */
export interface AntigravityModelWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityModelWireProfile>> = {
  'gemini-3.5-flash-extra-low': { modelEnum: 'MODEL_PLACEHOLDER_M187', maxOutputTokens: 65536 },
  'gemini-3.5-flash-low': { modelEnum: 'MODEL_PLACEHOLDER_M20', maxOutputTokens: 65536 },
  'gemini-3-flash-agent': { modelEnum: 'MODEL_PLACEHOLDER_M132', maxOutputTokens: 65536 },
  'gemini-3.1-pro-low': { modelEnum: 'MODEL_PLACEHOLDER_M36', maxOutputTokens: 65535 },
  'gemini-pro-agent': { modelEnum: 'MODEL_PLACEHOLDER_M16', maxOutputTokens: 65535 },
  // Claude on daily-cloudcode-pa rejects maxOutputTokens > 64000 with a 400.
  // The model_enum label is untracked for Anthropic ids; the backend does not
  // require it.
  'claude-sonnet-4-5': { maxOutputTokens: 64000 },
  'claude-sonnet-4-5-thinking': { maxOutputTokens: 64000 },
  'claude-opus-4-5': { maxOutputTokens: 64000 },
  'claude-opus-4-5-thinking': { maxOutputTokens: 64000 },
  'claude-sonnet-4-6': { maxOutputTokens: 64000 },
  'claude-sonnet-4-6-thinking': { maxOutputTokens: 64000 },
  'claude-opus-4-6': { maxOutputTokens: 64000 },
  'claude-opus-4-6-thinking': { maxOutputTokens: 64000 },
  'gpt-oss-120b': { maxOutputTokens: 32768 },
  'gpt-oss-120b-medium': { maxOutputTokens: 32768 },
};

/** Look up the wire profile for a routed (post-variant) model id. */
export function getAntigravityModelWireProfile(wireModelId: string): AntigravityModelWireProfile | undefined {
  return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}
