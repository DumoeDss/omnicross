/**
 * GeminiCodeAssistProjectResolver — runs the Google Code Assist project
 * handshake ONCE per account and caches the resolved Cloud AI Companion
 * project id.
 *
 * The gemini SUBSCRIPTION upstream (`cloudcode-pa.googleapis.com`) requires a
 * project id in its generateContent envelope for paid tiers. Brand-new
 * free-tier accounts have NO project (and sending one → Precondition Failed),
 * so `undefined` is a VALID resolved value. The resolution dance mirrors
 * gemini-cli `packages/core/src/code_assist/setup.ts`:
 *
 *   1. seed `projectId = GOOGLE_CLOUD_PROJECT || GOOGLE_CLOUD_PROJECT_ID`
 *      (may be empty; a purely-numeric value is rejected — Code Assist wants
 *      the human-readable project id, not the number).
 *   2. POST `:loadCodeAssist` with `{ cloudaicompanionProject, metadata }`.
 *      - If the response carries `currentTier` → already onboarded; use the
 *        response's `cloudaicompanionProject` (may be undefined for free-tier).
 *      - Else pick the onboarding tier (first `allowedTiers` with `isDefault`,
 *        default `legacy-tier`) and POST `:onboardUser`. For free-tier /
 *        legacy-tier the `cloudaicompanionProject` MUST be undefined; for
 *        standard-tier include it. `:onboardUser` returns an LRO — poll
 *        `:getOperation` until `done`, then read
 *        `response.cloudaicompanionProject.id`.
 *
 * Resolution result is cached in-memory keyed by access token (1:1 with the
 * account) so the handshake runs at most once per token. On a documented hard
 * failure (403 SERVICE_DISABLED / PERMISSION_DENIED, 429) we throw a clear
 * error WITHOUT caching, so a transient/permission issue can be retried after
 * the user fixes it.
 *
 * @module @omnicross/core/auth/GeminiCodeAssistProjectResolver
 */

import { fetchUpstream } from '../pipeline/upstreamFetch';
import {
  resolveCodeAssistApiVersion,
  resolveCodeAssistEndpoint,
} from '../transformer/transformers/GeminiCodeAssistTransformer';

/** Code Assist tier ids (gemini-cli `code_assist/types.ts`). The
 *  `standard-tier` id is the paid tier — it is the ONLY tier that includes a
 *  `cloudaicompanionProject` in onboardUser; free/legacy MUST omit it. */
const FREE_TIER_ID = 'free-tier';
const LEGACY_TIER_ID = 'legacy-tier';

/** LRO poll interval (gemini-cli uses 5000ms). */
const ONBOARD_POLL_INTERVAL_MS = 5000;
/** Safety cap on poll attempts so a stuck LRO can't hang forever. */
const ONBOARD_MAX_POLLS = 24; // ~2 minutes

interface LoadCodeAssistResponse {
  currentTier?: { id?: string };
  allowedTiers?: Array<{ id?: string; isDefault?: boolean; userDefinedCloudaicompanionProject?: boolean }>;
  cloudaicompanionProject?: string;
}

interface LongRunningOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: {
    cloudaicompanionProject?: { id?: string };
  };
}

/** A clear, surfaced error for the documented hard-failure modes. */
export class GeminiCodeAssistHandshakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GeminiCodeAssistHandshakeError';
  }
}

/** Injectable fetch so tests can mock the network without a live endpoint. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Per-dialect handshake parameters. The Cloud Code Assist project handshake is
 * SHARED between the gemini-cli subscription (`cloudcode-pa`) and the
 * antigravity subscription (`daily-cloudcode-pa`) — same `:loadCodeAssist` /
 * `:onboardUser` LRO dance, different endpoint, client metadata, and fallback
 * onboarding tier. The defaults preserve the gemini-cli behavior byte-identically.
 */
export interface CodeAssistResolverOptions {
  /**
   * Endpoint base override. Absent ⇒ the gemini-cli `cloudcode-pa` endpoint
   * (env-overridable). The antigravity dialect pins `daily-cloudcode-pa`.
   */
  endpoint?: string;
  /**
   * Handshake dialect: `'gemini-cli'` (default — the GEMINI plugin metadata
   * + `legacy-tier` fallback) or `'antigravity'` (the ANTIGRAVITY ideType
   * metadata + `free-tier` fallback; a resolved `undefined` project is a HARD
   * error — the antigravity envelope always carries a project).
   */
  dialect?: 'gemini-cli' | 'antigravity';
  /** upstream-proxy provider id for the default fetch seam (default `'gemini'`). */
  proxyProviderId?: string;
}

/** The antigravity dialect's handshake endpoint (`daily-cloudcode-pa`). */
export const ANTIGRAVITY_CODE_ASSIST_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';

export class GeminiCodeAssistProjectResolver {
  /** account access token → resolved project id (undefined = free-tier, no project). */
  private readonly cache = new Map<string, string | undefined>();
  /** In-flight handshakes so concurrent callers share one round-trip. */
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private readonly dialect: 'gemini-cli' | 'antigravity';
  private readonly endpoint: string | undefined;

  // upstream-proxy: the Code Assist handshake is upstream egress → honor the
  // dialect's proxy layer by default (still injectable for tests).
  constructor(
    fetchImpl?: FetchLike,
    options: CodeAssistResolverOptions = {},
  ) {
    this.dialect = options.dialect ?? 'gemini-cli';
    this.endpoint = options.endpoint;
    const providerId = options.proxyProviderId ?? 'gemini';
    this.fetchImpl =
      fetchImpl ?? ((url, init) => fetchUpstream(url, init, { providerId }));
  }

  private readonly fetchImpl: FetchLike;

  /** Test/diagnostic helper — clear the cached resolution for an account. */
  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  /**
   * Resolve (and cache) the Code Assist project for the given access token.
   * Runs the handshake at most once per token. Returns `undefined` for a
   * brand-new free-tier account (valid — the envelope sends no project).
   */
  async resolveProject(accessToken: string): Promise<string | undefined> {
    if (this.cache.has(accessToken)) {
      return this.cache.get(accessToken);
    }
    const existing = this.inflight.get(accessToken);
    if (existing) return existing;

    const run = this.runHandshake(accessToken)
      .then((project) => {
        this.cache.set(accessToken, project);
        return project;
      })
      .finally(() => {
        this.inflight.delete(accessToken);
      });
    this.inflight.set(accessToken, run);
    return run;
  }

  private codeAssistUrl(method: string): string {
    const base = this.endpoint ?? resolveCodeAssistEndpoint();
    return `${base}/${resolveCodeAssistApiVersion()}:${method}`;
  }

  /** The client metadata the dialect's upstream expects on the handshake calls. */
  private handshakeMetadata(project?: string): Record<string, unknown> {
    if (this.dialect === 'antigravity') {
      // The antigravity client tags its control-plane calls with its ideType
      // ONLY (captured from the reference client's loadCodeAssist/onboardUser).
      return { ideType: 'ANTIGRAVITY' };
    }
    return {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      duetProject: project,
    };
  }

  /** The tier id used when `allowedTiers` carries no default. */
  private get fallbackTierId(): string {
    return this.dialect === 'antigravity' ? FREE_TIER_ID : LEGACY_TIER_ID;
  }

  /** Seed project id from env; reject a purely-numeric value (project NUMBER). */
  private seedProjectId(): string {
    const seed = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || '';
    if (seed && /^\d+$/.test(seed.trim())) return '';
    return seed.trim();
  }

  private async runHandshake(accessToken: string): Promise<string | undefined> {
    const seededProject = this.seedProjectId();

    const load = await this.postCodeAssist<LoadCodeAssistResponse>('loadCodeAssist', accessToken, {
      cloudaicompanionProject: seededProject || undefined,
      metadata: this.handshakeMetadata(seededProject || undefined),
    });

    // Already onboarded — use the response's project (may be undefined free-tier
    // on the gemini-cli dialect).
    if (load.currentTier?.id) {
      return this.settleProject(load.cloudaicompanionProject || undefined);
    }

    // Pick the onboarding tier: first allowedTier with isDefault, else the
    // dialect's fallback tier.
    const defaultTier = load.allowedTiers?.find((t) => t.isDefault);
    const tierId = defaultTier?.id ?? this.fallbackTierId;

    // free-tier / legacy-tier MUST NOT send a project (→ Precondition Failed).
    const isFreeish = tierId === FREE_TIER_ID || tierId === LEGACY_TIER_ID;
    const onboardProject = isFreeish ? undefined : seededProject || undefined;

    let lro = await this.postCodeAssist<LongRunningOperation>('onboardUser', accessToken, {
      tierId,
      cloudaicompanionProject: onboardProject,
      metadata: this.handshakeMetadata(onboardProject),
    });

    // Poll the LRO until done.
    let polls = 0;
    while (!lro.done && polls < ONBOARD_MAX_POLLS) {
      await delay(ONBOARD_POLL_INTERVAL_MS);
      polls++;
      lro = await this.getOperation(accessToken, lro.name);
    }

    if (lro.error) {
      throw new GeminiCodeAssistHandshakeError(
        `Code Assist onboardUser failed: ${lro.error.message ?? 'unknown'}`,
        lro.error.code ?? 500,
      );
    }

    return this.settleProject(lro.response?.cloudaicompanionProject?.id || undefined);
  }

  /**
   * Final project settlement per dialect: gemini-cli treats `undefined` as the
   * valid fresh free-tier value; antigravity ALWAYS carries a project (its
   * envelope is rejected without one), so an absent project is a hard error.
   */
  private settleProject(project: string | undefined): string | undefined {
    if (project === undefined && this.dialect === 'antigravity') {
      throw new GeminiCodeAssistHandshakeError(
        'Code Assist loadCodeAssist did not return a cloudaicompanionProject (antigravity requires one)',
        502,
      );
    }
    return project;
  }

  /** POST a Code Assist method, surfacing the documented hard failures clearly. */
  private async postCodeAssist<T>(
    method: string,
    accessToken: string,
    body: unknown,
  ): Promise<T> {
    const url = this.codeAssistUrl(method);
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await this.throwForStatus(res, method);
    }
    return (await res.json()) as T;
  }

  private async getOperation(accessToken: string, name: string | undefined): Promise<LongRunningOperation> {
    // `getOperation` takes the operation `name` in the body (matching gemini-cli's
    // generic `callEndpoint('getOperation', { name })`).
    const url = this.codeAssistUrl('getOperation');
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      await this.throwForStatus(res, 'getOperation');
    }
    return (await res.json()) as LongRunningOperation;
  }

  /** Map a non-2xx Code Assist response to a clear, surfaced error. */
  private async throwForStatus(res: Response, method: string): Promise<never> {
    let detailCode: string | undefined;
    let detailMessage = '';
    try {
      const errBody = (await res.json()) as {
        error?: { status?: string; message?: string };
      };
      detailCode = errBody.error?.status;
      detailMessage = errBody.error?.message ?? '';
    } catch {
      /* non-JSON error body */
    }

    if (res.status === 403) {
      // SERVICE_DISABLED → the Cloud AI Companion API isn't enabled on the
      // project; PERMISSION_DENIED → token lacks the scope/role.
      throw new GeminiCodeAssistHandshakeError(
        `Code Assist ${method} denied (403 ${detailCode ?? 'PERMISSION_DENIED'}): ${
          detailMessage || 'enable the Cloud AI Companion API and grant the required role'
        }`,
        403,
        detailCode,
      );
    }
    if (res.status === 429) {
      throw new GeminiCodeAssistHandshakeError(
        `Code Assist ${method} rate-limited (429): ${detailMessage || 'quota exceeded, retry later'}`,
        429,
        detailCode,
      );
    }
    throw new GeminiCodeAssistHandshakeError(
      `Code Assist ${method} failed (${res.status}): ${detailMessage || res.statusText}`,
      res.status,
      detailCode,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Module singleton so the in-memory cache is shared across dispatch paths. */
let _resolverSingleton: GeminiCodeAssistProjectResolver | null = null;

export function getGeminiCodeAssistProjectResolver(): GeminiCodeAssistProjectResolver {
  if (!_resolverSingleton) {
    _resolverSingleton = new GeminiCodeAssistProjectResolver();
  }
  return _resolverSingleton;
}

/**
 * The ANTIGRAVITY-dialect singleton: same handshake class, pinned to
 * `daily-cloudcode-pa` + the ANTIGRAVITY metadata + the antigravity proxy
 * layer. A separate cache from the gemini resolver (the endpoints are
 * distinct upstreams; a token valid on both would share nothing anyway).
 */
let _antigravityResolverSingleton: GeminiCodeAssistProjectResolver | null = null;

export function getAntigravityProjectResolver(): GeminiCodeAssistProjectResolver {
  if (!_antigravityResolverSingleton) {
    _antigravityResolverSingleton = new GeminiCodeAssistProjectResolver(undefined, {
      endpoint: ANTIGRAVITY_CODE_ASSIST_ENDPOINT,
      dialect: 'antigravity',
      proxyProviderId: 'antigravity',
    });
  }
  return _antigravityResolverSingleton;
}
