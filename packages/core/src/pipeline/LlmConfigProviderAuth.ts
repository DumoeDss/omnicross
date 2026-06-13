/**
 * LlmConfigProviderAuth — `AuthSource` for LLM-config provider rows.
 *
 * Phase 2 of the `provider-request-pipeline` OpenSpec change (design D3, task 4.2).
 *
 * Wraps the two pieces that authenticate a normal (non-subscription) provider
 * request today:
 *
 *   - `getProviderHeaders(provider, apiKey)` — the format-specific auth
 *     headers (x-api-key / Authorization Bearer / x-goog-api-key / api-key)
 *     plus content-type and the OpenRouter app-attribution headers. `applyHeaders`
 *     merges these into the caller's header object VERBATIM (same output as a
 *     direct `getProviderHeaders` call).
 *   - `ApiKeyPoolService` — session-affine key selection + 429/529/401/403
 *     rotation. `onResult` reproduces the reportable-status branch of
 *     the host engine adapter's `callWithPoolReporting` (report → re-bind →
 *     return the new key) and the success branch (`reportSuccess`).
 *
 * IMPORTANT (Phase 2 scope): this class is DEFINED + unit-tested in isolation
 * only. NO caller routes through it yet — `executeProviderCall` is unchanged
 * and the rotation INTEGRATION is Phase 3 (D5). Do not wire `onResult` into a
 * fetch loop in this phase.
 *
 * @module pipeline/LlmConfigProviderAuth
 */

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import type { ApiKeyPoolService } from '../completion/ApiKeyPoolService';
import { getProviderHeaders } from '../completion/header-builder';

import type { AuthApplyHints, AuthResultOutcome, AuthSource } from './AuthSource';

/**
 * HTTP statuses the pool treats as reportable — identical to
 * `callWithPoolReporting`'s `reportable` guard (429 / 529 rate-limit,
 * 401 / 403 auth-failure). Any other status no-ops in `onResult`.
 */
function isReportableStatus(status: number | null): status is number {
  return status === 429 || status === 529 || status === 401 || status === 403;
}

export interface LlmConfigProviderAuthOptions {
  /** Provider row whose auth format + key drives header assembly. */
  provider: LLMProvider;
  /** Resolved API key string to authenticate with (post env-ref resolution). */
  apiKey: string;
  /**
   * Pool service for rotation, when this request is pool-backed. Omit (or pass
   * `null`) for legacy single-key requests — `onResult` then never touches the
   * pool (matching `fromPool === false`).
   */
  apiKeyPool?: ApiKeyPoolService | null;
  /** Provider id the pool should report/select against (the ACTUAL provider
   *  whose key was resolved, post-routing). Required for pool participation. */
  providerId?: string;
  /** Session id for pool affinity + rebind. Required for pool participation. */
  sessionId?: string | null;
}

export class LlmConfigProviderAuth implements AuthSource {
  private readonly provider: LLMProvider;
  private readonly apiKeyPool: ApiKeyPoolService | null;
  private readonly providerId: string | undefined;
  private readonly sessionId: string | null | undefined;

  /**
   * The current resolved key. Mutable so a Phase-3 caller can read the
   * rotated key after `onResult`; this phase it is only set at construction
   * and updated inside `onResult` (mirroring the inline re-point in
   * `callWithPoolReporting`).
   */
  apiKey: string;

  constructor(opts: LlmConfigProviderAuthOptions) {
    this.provider = opts.provider;
    this.apiKey = opts.apiKey;
    this.apiKeyPool = opts.apiKeyPool ?? null;
    this.providerId = opts.providerId;
    this.sessionId = opts.sessionId;
  }

  /**
   * Merge the provider auth headers (and content-type / OpenRouter app
   * headers) into `headers`, exactly as a direct `getProviderHeaders` call
   * would produce them. `hints` are accepted for contract symmetry but the
   * provider-key path does not vary headers by URL/model.
   */
  applyHeaders(headers: Record<string, string>, _hints: AuthApplyHints): void {
    const authHeaders = getProviderHeaders(this.provider, this.apiKey);
    for (const [k, v] of Object.entries(authHeaders)) {
      headers[k] = v;
    }
  }

  /**
   * React to the final HTTP status — the pool-rotation seam (design D5).
   *
   * Reproduces `callWithPoolReporting`'s reportable + success branches:
   *  - reportable status (429/529/401/403) on a pool-backed request →
   *    `reportError(providerId, sessionId, status)`; when it hands back a
   *    `newKey` the session was re-bound, so we adopt it (`this.apiKey`) and
   *    return `{ rebound: true, newKey }`. When no key is available it returns
   *    `{ rebound: false }` (the session is still cooled/disabled by the report).
   *  - success / any 2xx → `reportSuccess(sessionId)`; `{ rebound: false }`.
   *  - non-reportable, non-success, or non-pool request → no-op
   *    `{ rebound: false }`.
   *
   * NOTE: no caller invokes this in Phase 2; it is unit-tested in isolation.
   */
  async onResult(status: number | null): Promise<AuthResultOutcome> {
    // The same three-part guard `callWithPoolReporting` uses (`fromPool &&
    // apiKeyPool && sessionId`). Provider-key requests without a pool/session
    // never rotate. Captured as locals so the rest of the method needs no
    // non-null assertions.
    const pool = this.apiKeyPool;
    const providerId = this.providerId;
    const sessionId = this.sessionId;
    if (!pool || !providerId || !sessionId) {
      return { rebound: false };
    }

    if (isReportableStatus(status)) {
      const newKey = await pool.reportError(providerId, sessionId, status);
      if (newKey) {
        // reportError re-bound the session to a new key — adopt it so a
        // Phase-3 inline retry uses the rotated credential.
        this.apiKey = newKey;
        return { rebound: true, newKey };
      }
      return { rebound: false };
    }

    // Treat any 2xx as success (mirrors `result.success` → reportSuccess).
    if (status !== null && status >= 200 && status < 300) {
      pool.reportSuccess(sessionId);
    }
    return { rebound: false };
  }
}
