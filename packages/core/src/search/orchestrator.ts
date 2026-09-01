/**
 * The search orchestrator — the ONE fallback implementation in Omnicross.
 *
 * Before this module the repo had three provider orders (the host orchestrator,
 * the HTTP-only service, and `BuiltinToolExecutor`'s own list), which is how a
 * query could be sent to a provider twice, or to one a policy meant to exclude.
 * Plan 阶段3's exit condition is that exactly one implementation decides which
 * provider runs next, and that no request ever falls back twice. Both are
 * structural here: consumers submit ONE request and get one answer, with no
 * loop of their own.
 *
 * The semantics that are easy to get wrong, stated plainly:
 *
 * - **An empty result set is a SUCCESS.** A provider that returns `[]` has
 *   already walked its own candidates and is reporting "nothing found". Treating
 *   that as a failure would re-conflate the empty-vs-broken distinction 阶段2
 *   built, so it ends the walk. (A deliberate divergence from Elftia, which
 *   continues to the next provider on zero results — recorded for 阶段5's
 *   allowed-differences list.)
 * - **A pinned provider never falls back.** `request.provider` is a caller's
 *   explicit choice; silently trying someone else would send the query
 *   somewhere it was not authorized to go, and would be the second fallback in
 *   a caller that has its own.
 * - **Cancellation ends everything immediately.** It is the caller's decision,
 *   not a provider failure, and must never spend another candidate.
 *
 * Observability is emitted here because this is where attempts happen, and it
 * carries a query HASH only — plan §11.3. No event field can hold query text, a
 * URL, or result content.
 *
 * @module search/orchestrator
 */

import type {
  OrchestratedSearchResponse,
  SearchAttempt,
  SearchErrorCode,
  SearchPolicy,
  SearchProviderContribution,
  SearchProviderId,
  SearchRequest,
  SearchRuntimeEvent,
} from '@omnicross/contracts/search-types';
import { SearchProviderError, toSearchErrorShape } from '@omnicross/contracts/search-types';
import { createHash, randomUUID } from 'node:crypto';

import { normalizeSearchResults } from './normalize';
import type { SearchProviderRegistry } from './registry';

/** Receives runtime events. Exceptions from it are swallowed, never propagated. */
export type SearchRuntimeEventListener = (event: SearchRuntimeEvent) => void;

/** Construction-time orchestrator configuration. */
export interface SearchOrchestratorOptions {
  /** Default policy for every search; a per-call policy overrides it field by field. */
  policy?: SearchPolicy;
  /** Observability sink (plan §11.3). */
  onEvent?: SearchRuntimeEventListener;
}

/** Characters of the SHA-256 digest used as a query correlation key. */
const QUERY_HASH_LENGTH = 12;

/**
 * A short, one-way key for correlating the events of one query.
 *
 * Truncated deliberately: enough to group events, far too little to attack the
 * preimage of a full query with, and the events channel is the one place a
 * query must never appear in the clear.
 */
export function hashSearchQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, QUERY_HASH_LENGTH);
}

/** The order candidates will be attempted in, plus how it was decided. */
interface CandidatePlan {
  candidates: SearchProviderContribution[];
  /** Emitted before the walk: a preferred provider that could not be used. */
  skippedPreferred?: { providerId: SearchProviderId; errorCode: SearchErrorCode };
}

export class SearchOrchestrator {
  private readonly registry: SearchProviderRegistry;
  private readonly defaultPolicy: SearchPolicy;
  private readonly onEvent?: SearchRuntimeEventListener;

  constructor(registry: SearchProviderRegistry, options: SearchOrchestratorOptions = {}) {
    this.registry = registry;
    this.defaultPolicy = options.policy ?? {};
    this.onEvent = options.onEvent;
  }

  /**
   * Run one search.
   *
   * @param request - the query, an optional pinned provider, and per-request
   *   options. `options` is passed to the provider untouched: providers own
   *   their own timeouts and the orchestrator adds no second timeout layer.
   * @param policyOverride - per-request policy, merged field-by-field over the
   *   orchestrator's default.
   * @throws {SearchProviderError} when no provider produced a response.
   */
  async search(
    request: SearchRequest,
    policyOverride?: SearchPolicy,
  ): Promise<OrchestratedSearchResponse> {
    const policy = { ...this.defaultPolicy, ...policyOverride };
    const requestId = randomUUID();
    const queryHash = hashSearchQuery(request.query);
    const startedAt = Date.now();
    const attempts: SearchAttempt[] = [];

    const emitComplete = (providerId: SearchProviderId | undefined, resultCount: number): void => {
      this.emit({
        type: 'search_complete',
        requestId,
        queryHash,
        ...(providerId === undefined ? {} : { providerId }),
        resultCount,
        fallbackCount: fallbackCountOf(attempts),
        durationMs: Date.now() - startedAt,
      });
    };

    let plan: CandidatePlan;
    try {
      plan = this.planCandidates(request, policy);
    } catch (error) {
      // Pinned-mode pre-flight rejection: nothing ran, but the search is over.
      emitComplete(undefined, 0);
      throw error;
    }

    if (plan.skippedPreferred !== undefined) {
      // Observability only — a provider that was never attempted is not an
      // attempt, and must not inflate `attempts` or the fallback count.
      this.emit({
        type: 'search_attempt',
        requestId,
        queryHash,
        providerId: plan.skippedPreferred.providerId,
        outcome: 'failed',
        errorCode: plan.skippedPreferred.errorCode,
        durationMs: 0,
      });
    }

    let lastError: SearchProviderError | undefined;

    for (const candidate of plan.candidates) {
      const attemptStartedAt = Date.now();
      try {
        const produced = await candidate.provider.search(request.query, request.options);
        const durationMs = Date.now() - attemptStartedAt;
        // The PROVIDER's answer decides the walk; normalization only filters
        // what that answer contains. See normalize.ts on why filtering can
        // never turn a success back into a failure.
        const results = normalizeSearchResults(produced, request.options?.maxResults);

        attempts.push({
          providerId: candidate.id,
          outcome: 'success',
          resultCount: results.length,
          durationMs,
        });
        this.emit({
          type: 'search_attempt',
          requestId,
          queryHash,
          providerId: candidate.id,
          outcome: 'success',
          resultCount: results.length,
          durationMs,
        });
        emitComplete(candidate.id, results.length);

        return {
          query: request.query,
          providerId: candidate.id,
          results,
          attempts,
          fallbackCount: fallbackCountOf(attempts),
        };
      } catch (error) {
        const durationMs = Date.now() - attemptStartedAt;
        const shape = toSearchErrorShape(error);

        // The signal is the authority on cancellation, not the provider's
        // choice of error. A provider is contractually required to map an abort
        // to `cancelled`, but a non-conforming one (a future host or 阶段4
        // adapter letting a raw AbortError escape) would otherwise look like
        // `upstream_unavailable` — and the walk would keep sending an already
        // cancelled query to further providers. Egress after cancellation is
        // the failure mode worth being defensive about.
        const isCancelled =
          shape.code === 'cancelled' || request.options?.signal?.aborted === true;
        const errorCode = isCancelled ? 'cancelled' : shape.code;

        // The candidate ran, so it is an attempt whatever it threw.
        attempts.push({
          providerId: candidate.id,
          outcome: 'failed',
          errorCode,
          durationMs,
        });
        this.emit({
          type: 'search_attempt',
          requestId,
          queryHash,
          providerId: candidate.id,
          outcome: 'failed',
          errorCode,
          durationMs,
        });

        if (isCancelled) {
          emitComplete(undefined, 0);
          // A provider that reported cancellation correctly keeps its own error
          // — it carries the better diagnosis. One that leaked a raw abort gets
          // the taxonomy code the signal implies, with the original as `cause`.
          throw shape.code === 'cancelled'
            ? error
            : new SearchProviderError('cancelled', 'search was cancelled by the caller', {
                providerId: candidate.id,
                retryable: false,
                cause: error,
              });
        }

        lastError = asSearchProviderError(error, shape.code, shape.message, candidate.id);
      }
    }

    emitComplete(undefined, 0);
    throw exhaustionError(attempts, lastError);
  }

  /** Resolve the candidate list for one request. */
  private planCandidates(request: SearchRequest, policy: SearchPolicy): CandidatePlan {
    if (request.provider !== undefined) {
      const pinned = this.registry.get(request.provider);
      if (pinned === undefined) {
        throw new SearchProviderError(
          'upstream_unavailable',
          `search provider '${request.provider}' is not registered in this runtime`,
          { providerId: request.provider, retryable: false },
        );
      }
      if (!isAllowed(pinned.id, policy)) {
        throw new SearchProviderError(
          'policy_denied',
          `search provider '${request.provider}' is not allowed by the active search policy`,
          { providerId: request.provider, retryable: false },
        );
      }
      // Exactly one candidate: a pinned provider's failure is final.
      return { candidates: [pinned] };
    }

    const allowed = this.registry.list().filter((entry) => isAllowed(entry.id, policy));

    let ordered = allowed;
    let skippedPreferred: CandidatePlan['skippedPreferred'];
    if (policy.preferred !== undefined) {
      const preferred = allowed.find((entry) => entry.id === policy.preferred);
      if (preferred === undefined) {
        // A preference for a provider that is not registered, or not allowed,
        // is a soft signal: it is recorded and ignored, never an error. (Pinning
        // is the way to say "this provider or nothing".)
        skippedPreferred = {
          providerId: policy.preferred,
          errorCode: this.registry.has(policy.preferred) ? 'policy_denied' : 'upstream_unavailable',
        };
      } else {
        ordered = [preferred, ...allowed.filter((entry) => entry.id !== preferred.id)];
      }
    }

    if (policy.fallbackEnabled === false) ordered = ordered.slice(0, 1);
    if (policy.maxAttempts !== undefined) {
      // Not clamped upward: `maxAttempts: 0` means "attempt nothing", and the
      // exhaustion error reports that honestly rather than silently searching.
      ordered = ordered.slice(0, Math.max(0, Math.floor(policy.maxAttempts)));
    }

    return { candidates: ordered, ...(skippedPreferred === undefined ? {} : { skippedPreferred }) };
  }

  /** Deliver one event. A listener that throws must never fail a search. */
  private emit(event: SearchRuntimeEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(event);
    } catch {
      // Observability is not allowed to have opinions about search outcomes.
    }
  }
}

/** Attempts beyond the first. */
function fallbackCountOf(attempts: readonly SearchAttempt[]): number {
  return Math.max(0, attempts.length - 1);
}

/** Whether `policy.allowed` admits an id. An absent list allows everything. */
function isAllowed(id: SearchProviderId, policy: SearchPolicy): boolean {
  return policy.allowed === undefined || policy.allowed.includes(id);
}

/**
 * Keep a provider's own error object when it threw one, otherwise wrap.
 *
 * Preserving the instance keeps its `details` (the HTTP slice's `stage`, status
 * codes, hostnames) intact for the single-candidate case, where that diagnosis
 * is the whole answer.
 */
function asSearchProviderError(
  error: unknown,
  code: SearchErrorCode,
  message: string,
  providerId: SearchProviderId,
): SearchProviderError {
  if (error instanceof SearchProviderError) return error;
  return new SearchProviderError(code, message, { providerId, cause: error });
}

/**
 * The error thrown when no candidate produced a response.
 *
 * A single failed candidate surfaces ITS error unchanged — with one attempt
 * there is nothing to summarize, and the provider's diagnosis is more useful
 * than a restatement of it. Beyond that, the code of the LAST failure is the
 * one a caller sees, with a compact trail naming every provider and code.
 * Structured attempts travel on `OrchestratedSearchResponse.attempts` and the
 * events channel; `details` stays `Record<string, string>` so nothing nested
 * can smuggle content into a log.
 */
function exhaustionError(
  attempts: readonly SearchAttempt[],
  lastError: SearchProviderError | undefined,
): SearchProviderError {
  if (attempts.length === 1 && lastError !== undefined) return lastError;

  if (attempts.length === 0) {
    return new SearchProviderError(
      'upstream_unavailable',
      'no eligible search provider was available (0 attempts)',
      { retryable: false },
    );
  }

  const trail = attempts
    .map((attempt) => `${attempt.providerId}:${attempt.errorCode ?? 'unknown'}`)
    .join(',');

  return new SearchProviderError(
    lastError?.code ?? 'upstream_unavailable',
    `search failed after ${attempts.length} attempt(s)`,
    { retryable: lastError?.retryable, details: { attempts: trail }, cause: lastError },
  );
}
