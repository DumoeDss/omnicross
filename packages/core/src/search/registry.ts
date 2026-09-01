/**
 * The search provider registry — one place that knows which providers exist.
 *
 * Registration is by CONTRIBUTION, not by class: a provider arrives with its
 * `source` and `kind` declared, so nothing downstream has to guess a trust
 * boundary from an id's spelling. That is what makes this registry usable by a
 * Phase-2 host unchanged — Elftia's `local-*` providers register through the
 * same call an Omnicross builtin does, with `source: 'host'` stated.
 *
 * Two rules worth stating out loud:
 *
 * 1. **Registration failures are NOT search failures.** They throw
 *    {@link SearchRegistryError}, a plain `Error`, never a
 *    `SearchProviderError`. The eight-code taxonomy exists so a fallback policy
 *    can decide what to do next; a duplicate id is a wiring bug with no "next"
 *    to decide on, and letting it wear a taxonomy code would teach the
 *    orchestrator to fall back from a programming error.
 * 2. **Ordering lives here, once.** `list()` is the single answer to "in what
 *    order do providers come?", which is the scattered decision plan 阶段3
 *    exists to consolidate.
 *
 * @module search/registry
 */

import type {
  SearchContributionContext,
  SearchProviderContribution,
  SearchProviderId,
} from '@omnicross/contracts/search-types';

/**
 * A registration was rejected.
 *
 * Deliberately not a `SearchProviderError`: see rule 1 in the module doc.
 */
export class SearchRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchRegistryError';
    // Keeps `instanceof` working when the class is transpiled down or a bundler
    // rebuilds the prototype chain — the same hazard `SearchProviderError`
    // guards against in contracts.
    Object.setPrototypeOf(this, SearchRegistryError.prototype);
  }
}

/** Construction-time registry policy. */
export interface SearchProviderRegistryOptions {
  /**
   * Allow a `source: 'host'` contribution to replace a registered
   * `source: 'builtin'` one.
   *
   * Default `false` — plan §7.2's default-deny. This is the admin-policy
   * escape hatch, not a convenience: shadowing a builtin silently changes where
   * a user's queries are sent.
   */
  allowBuiltinOverride?: boolean;
}

/** A contribution plus the bookkeeping `list()` orders by. */
interface RegistryEntry {
  contribution: SearchProviderContribution;
  context?: SearchContributionContext;
  /** Monotonic registration sequence; the tie-breaker for equal hints. */
  sequence: number;
}

/**
 * The registered providers, ordered.
 *
 * Not a singleton: a runtime owns one. Tests, hosts, and future multi-tenant
 * assemblies each get their own without global state to reset.
 */
export class SearchProviderRegistry {
  private readonly entries = new Map<SearchProviderId, RegistryEntry>();
  private readonly allowBuiltinOverride: boolean;
  private nextSequence = 0;

  constructor(options: SearchProviderRegistryOptions = {}) {
    this.allowBuiltinOverride = options.allowBuiltinOverride === true;
  }

  /**
   * Register one provider.
   *
   * @param contribution - the provider with its origin, transport, and
   *   capabilities declared.
   * @param context - who is registering, for a Phase-2 host. Retained as-is;
   *   no rule reads it today, and the parameter exists so adding one later is
   *   not a signature change for every caller.
   * @throws {SearchRegistryError} on a blank id, a duplicate id, or a host
   *   contribution colliding with a builtin without `allowBuiltinOverride`.
   */
  register(contribution: SearchProviderContribution, context?: SearchContributionContext): void {
    const id = contribution.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new SearchRegistryError('a search provider contribution needs a non-blank id');
    }

    const existing = this.entries.get(id);
    let sequence = this.nextSequence;
    if (existing !== undefined) {
      // The ONLY collision that is not an error: an explicitly permitted host
      // override of a builtin. Both halves are read from the declared `source`
      // fields — never from how the ids are spelled.
      const isPermittedOverride =
        this.allowBuiltinOverride &&
        contribution.source === 'host' &&
        existing.contribution.source === 'builtin';

      if (!isPermittedOverride) {
        throw new SearchRegistryError(
          existing.contribution.source === 'builtin' && contribution.source === 'host'
            ? `search provider '${id}' is a builtin; overriding it requires allowBuiltinOverride`
            : `search provider '${id}' is already registered`,
        );
      }

      // An override replaces IN PLACE: it inherits the slot of the provider it
      // shadows, so an admin swapping an implementation does not also, silently,
      // demote it to the end of the fallback order. (Explicit `unregister` then
      // `register` does move it — that is a removal, not a substitution.)
      sequence = existing.sequence;
    } else {
      this.nextSequence += 1;
    }

    this.entries.set(id, { contribution, context, sequence });
  }

  /** Whether an id is currently registered. */
  has(id: SearchProviderId): boolean {
    return this.entries.has(id);
  }

  /** The contribution registered under `id`, if any. */
  get(id: SearchProviderId): SearchProviderContribution | undefined {
    return this.entries.get(id)?.contribution;
  }

  /**
   * Remove a provider.
   *
   * The Phase-2 host-disconnect hook: when a host goes away its contributions
   * go with it, and the id becomes free to register again.
   *
   * @returns whether something was removed.
   */
  unregister(id: SearchProviderId): boolean {
    return this.entries.delete(id);
  }

  /**
   * Every registered contribution, in candidate order.
   *
   * `priorityHint` ascending; contributions without a hint come AFTER every
   * hinted one (an absent hint is "no opinion", not "highest priority"); ties
   * keep registration order. The builtin HTTP contributions carry no hints, so
   * today this is exactly registration order.
   */
  list(): SearchProviderContribution[] {
    return [...this.entries.values()]
      .sort((a, b) => {
        const aHint = a.contribution.priorityHint;
        const bHint = b.contribution.priorityHint;
        if (aHint !== bHint) {
          if (aHint === undefined) return 1;
          if (bHint === undefined) return -1;
          return aHint - bHint;
        }
        return a.sequence - b.sequence;
      })
      .map((entry) => entry.contribution);
  }
}
