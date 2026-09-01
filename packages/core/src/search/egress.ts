/**
 * The SSRF egress policy every search network path runs through
 * (plan hard-constraint 7).
 *
 * 阶段4 introduces the first attacker-influenceable network surface in the
 * search tree: a custom `apiHost`. Until now every search request went to one
 * of two fixed engines, so a URL built from configuration could not be aimed at
 * an internal address. It can now, which is why this module exists and why it
 * guards BOTH the API transport and the HTTP slice's redirect walk rather than
 * living inside one adapter.
 *
 * Two layers, because one is not enough:
 *
 * 1. {@link validateEgressUrl} — a URL-level check applied to the initial URL
 *    and to EVERY redirect hop. It catches literal addresses and the named
 *    loopback/metadata hosts before a request is built.
 * 2. {@link createEgressGuardedDispatcher} — a connection-time check of every
 *    address DNS resolves to. Layer 1 alone is a TOCTOU: `evil.example` passes
 *    the URL check as a public name and then resolves to `127.0.0.1`. Validating
 *    at the moment of use closes that rebinding window.
 *
 * The division of labour between them is worth stating, because it is the
 * easiest thing to misread here: layer 1 can only judge what a URL SAYS, so it
 * denies literal addresses and the two host names that are denied by name
 * (`localhost`, `metadata.google.internal`). An ordinary internal name like
 * `searx.internal.corp` carries no address and passes layer 1 exactly as a
 * public name would — layer 2 is what asks where it actually points. Neither
 * layer is redundant: layer 1 stops `http://169.254.169.254/` without a
 * resolver, and layer 2 stops every name that lies.
 *
 * LIMITATION, stated here because it is a property of the design and not an
 * oversight: layer 2 only applies to DIRECT connections. When a proxy
 * dispatcher is in use the proxy resolves DNS, so the guarded lookup never
 * runs; proxied paths keep layer 1 on every hop and nothing more. The
 * precedence is asserted by a test rather than left to be discovered.
 *
 * Denial messages carry the HOSTNAME only. A search URL embeds the user's
 * query and may carry userinfo credentials, and these errors are printed,
 * logged, and returned to callers.
 *
 * @module search/egress
 */

import { lookup as defaultDnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import {
  isSearchProviderError,
  SearchProviderError,
  type SearchProviderId,
} from '@omnicross/contracts/search-types';
import { Agent, type Dispatcher } from 'undici';

/**
 * The admin-level egress policy.
 *
 * Construction-level, never per-request: a per-request allowlist would let an
 * attacker who can influence a search request also influence where it may go,
 * which is the whole thing this module prevents.
 */
export interface SearchEgressPolicy {
  /**
   * Hostnames permitted to resolve into an otherwise-denied address class.
   *
   * The escape hatch for an internal SearXNG deployment
   * (`searx.internal.corp`). Matching is EXACT and case-insensitive — no
   * wildcards, no suffix matching — because a suffix rule (`.corp`) is one
   * attacker-registered subdomain away from admitting anything.
   */
  allowedPrivateHosts?: string[];
}

/** Permit every public host; permit nothing private. The production default. */
export const DEFAULT_SEARCH_EGRESS_POLICY: Readonly<SearchEgressPolicy> = Object.freeze({});

/** Why a host was denied. Stamped into `details.egressClass` for diagnostics. */
export type EgressDenialReason =
  | 'scheme'
  | 'malformed'
  | 'loopback'
  | 'unspecified'
  | 'link-local'
  | 'private'
  | 'unique-local'
  | 'metadata';

/** The schemes a search request may ever use. */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The one metadata endpoint that is a bare name rather than an address. */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set(['metadata.google.internal']);

/** Human-readable text for each denial class. */
const DENIAL_TEXT: Readonly<Record<EgressDenialReason, string>> = Object.freeze({
  scheme: 'only http and https are permitted',
  malformed: 'the request target is not a valid absolute URL',
  loopback: 'loopback addresses are not permitted',
  unspecified: 'unspecified addresses are not permitted',
  'link-local': 'link-local addresses are not permitted',
  private: 'private addresses are not permitted',
  'unique-local': 'unique-local addresses are not permitted',
  metadata: 'cloud metadata endpoints are not permitted',
});

/**
 * Validate one request target against the policy.
 *
 * @param url - the target. A relative or unparseable value is a denial, not a
 *   crash: a redirect `location` is attacker-controlled input.
 * @returns the parsed URL, so callers can reuse it instead of re-parsing.
 * @throws SearchProviderError code `policy_denied`, naming the hostname only.
 */
export function validateEgressUrl(
  url: string | URL,
  policy: SearchEgressPolicy = DEFAULT_SEARCH_EGRESS_POLICY,
  providerId?: SearchProviderId,
): URL {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    // Deliberately does not echo the value: an unparseable target is still
    // attacker-supplied text.
    throw egressDenied('unknown-host', 'malformed', providerId);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw egressDenied(parsed.hostname || 'unknown-host', 'scheme', providerId, parsed.protocol);
  }

  const hostname = parsed.hostname;
  if (isAllowlisted(hostname, policy)) return parsed;

  const denial = classifyHostname(hostname);
  if (denial) throw egressDenied(hostname, denial, providerId);
  return parsed;
}

/**
 * Classify a resolved ADDRESS for a hostname that already passed
 * {@link validateEgressUrl}.
 *
 * Separate from the URL check because this is the rebinding defense: the
 * hostname was public, the address it resolved to may not be. Allowlisting is
 * by hostname, so an allowlisted name's private address is admitted here too —
 * that is exactly what the SearXNG escape hatch means.
 */
export function assertEgressAddressAllowed(
  address: string,
  hostname: string,
  policy: SearchEgressPolicy = DEFAULT_SEARCH_EGRESS_POLICY,
  providerId?: SearchProviderId,
): void {
  if (isAllowlisted(hostname, policy)) return;
  const denial = classifyAddress(address);
  if (denial) throw egressDenied(hostname, denial, providerId, undefined, address);
}

/** Whether the policy names this hostname exactly (case-insensitive). */
function isAllowlisted(hostname: string, policy: SearchEgressPolicy): boolean {
  const allowed = policy.allowedPrivateHosts;
  if (!allowed || allowed.length === 0) return false;
  const normalized = normalizeHostname(hostname);
  return allowed.some((entry) => normalizeHostname(entry) === normalized);
}

/**
 * Reduce a hostname to the form the rules compare against: lowercase, no
 * trailing dots, no IPv6 brackets.
 *
 * The trailing-dot strip is a security fix, not tidiness.
 * `metadata.google.internal.` is the fully-qualified spelling of the same host
 * and every resolver treats the two as identical — but the WHATWG URL parser
 * normalizes a trailing dot off IP LITERALS only and PRESERVES it on names, so
 * a name-based denylist that compares raw hostnames is bypassed by adding one
 * character. That is exactly the layer the name rules own, and on a proxied
 * connection (where the DNS-time check cannot run) it is the only layer there
 * is.
 *
 * ALL trailing dots go, not one: `new URL('http://localhost../')` parses and
 * yields the hostname `localhost..`, so stripping a single dot would leave
 * `localhost.` and the bypass intact.
 *
 * Applied to the denial classification AND to both sides of the allowlist
 * comparison, so `searx.internal.corp` and `searx.internal.corp.` are the same
 * entry whichever form the operator writes in either place.
 */
function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase().replace(/\.+$/, '');
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Classify a URL hostname: a literal address by its range, a name by the two
 * name-based rules.
 *
 * Literal addresses are classified AFTER `new URL()` normalization, which is
 * what closes the alternate-notation bypasses: the WHATWG host parser turns
 * `http://2130706433/`, `http://0177.0.0.1/` and `http://0x7f.1/` all into
 * `127.0.0.1` before this function ever sees them.
 */
function classifyHostname(hostname: string): EgressDenialReason | undefined {
  const candidate = normalizeHostname(hostname);
  if (candidate === '') return 'malformed';

  const version = isIP(candidate);
  if (version !== 0) return classifyAddress(candidate);

  // Name-based rules. `localhost` is a name, not an address, and resolvers are
  // free to answer it however they like — so it is denied by name as well as by
  // whatever it resolves to.
  if (candidate === 'localhost' || candidate.endsWith('.localhost')) return 'loopback';
  if (METADATA_HOSTNAMES.has(candidate)) return 'metadata';
  return undefined;
}

/** Classify a literal IPv4 or IPv6 address. `undefined` means "public". */
function classifyAddress(address: string): EgressDenialReason | undefined {
  const candidate = normalizeHostname(address);
  const version = isIP(candidate);
  if (version === 4) return classifyIPv4(candidate);
  if (version === 6) return classifyIPv6(candidate);
  // Not an address at all. Callers pass resolver output here, so this is a
  // resolver returning something unexpected — deny rather than assume.
  return 'malformed';
}

function classifyIPv4(address: string): EgressDenialReason | undefined {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return 'malformed';
  const [a, b, c, d] = octets;

  if (a === 127) return 'loopback';
  // 0.0.0.0/8 is not in the plan's named list, and is denied anyway: on Linux a
  // connection to 0.0.0.0 reaches localhost, which makes it a loopback bypass
  // in every SSRF filter that forgets it. Nothing public lives there.
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // Metadata before link-local: 169.254.169.254 is in 169.254.0.0/16, and the
  // more specific reason is the more useful diagnostic.
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
  if (a === 169 && b === 254) return 'link-local';
  return undefined;
}

function classifyIPv6(address: string): EgressDenialReason | undefined {
  const pieces = parseIPv6Pieces(address);
  if (!pieces) return 'malformed';

  // An IPv4-mapped (`::ffff:10.0.0.1`) or IPv4-compatible (`::127.0.0.1`)
  // address is the embedded IPv4 wearing a hat. `new URL()` re-serializes the
  // mapped form to hex (`[::ffff:a00:1]`), so string matching on `::ffff:`
  // would miss it — the check has to be on the parsed pieces.
  const topIsZero = pieces.slice(0, 5).every((piece) => piece === 0);
  if (topIsZero && (pieces[5] === 0xffff || pieces[5] === 0)) {
    const embedded = [pieces[6] >> 8, pieces[6] & 0xff, pieces[7] >> 8, pieces[7] & 0xff];
    const isLoopbackOrUnspecified = pieces[5] === 0 && pieces[6] === 0 && pieces[7] <= 1;
    if (isLoopbackOrUnspecified) return pieces[7] === 1 ? 'loopback' : 'unspecified';
    return classifyIPv4(embedded.join('.'));
  }

  if ((pieces[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((pieces[0] & 0xfe00) === 0xfc00) return 'unique-local';
  return undefined;
}

/**
 * Parse an IPv6 literal into its eight 16-bit pieces.
 *
 * `node:net.isIP` validates but does not decompose, and the range checks need
 * the pieces. Assumes the input already passed `isIP` — it is lenient about
 * anything that could not have got past it.
 */
function parseIPv6Pieces(address: string): number[] | undefined {
  let text = address.split('%')[0];

  // A trailing dotted quad (`::ffff:1.2.3.4`) becomes the two hex pieces it
  // encodes, so the rest of the parser only ever sees hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return undefined;
    const octets = tail.split('.').map((part) => Number.parseInt(part, 10));
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    groups = head;
  } else {
    const zeros = 8 - head.length - rest.length;
    if (zeros < 1) return undefined;
    groups = [...head, ...Array.from({ length: zeros }, () => '0'), ...rest];
  }

  const pieces: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    pieces.push(Number.parseInt(group, 16));
  }
  return pieces;
}

/** Build the one denial error, hostname-only by construction. */
function egressDenied(
  hostname: string,
  reason: EgressDenialReason,
  providerId?: SearchProviderId,
  scheme?: string,
  resolvedAddress?: string,
): SearchProviderError {
  const subject = scheme ? `scheme "${scheme}"` : `host "${hostname}"`;
  const via = resolvedAddress ? ` (resolved to a ${reason} address)` : '';
  const details: Record<string, string> = { host: hostname, egressClass: reason };
  if (resolvedAddress) details.egressStage = 'dns';
  return new SearchProviderError(
    'policy_denied',
    `egress policy denied ${subject}${via}: ${DENIAL_TEXT[reason]}`,
    {
      providerId,
      retryable: false,
      details,
    },
  );
}

/**
 * The `policy_denied` error buried in a thrown value's `cause` chain, if any.
 *
 * undici reports a connect-time failure as a `TypeError: fetch failed` whose
 * `cause` holds the real error, so a denial raised inside the guarded lookup
 * reaches the caller wrapped. Without this the transport would classify a
 * blocked rebinding attempt as `upstream_unavailable`.
 *
 * The depth cap assumes undici's wrapping stays SHALLOW — today it is two
 * levels and this allows six. If a future undici (or an intermediate
 * dispatcher) nests deeper, a blocked rebinding attempt would quietly
 * reclassify as a transport failure: the request is still refused, but the
 * security signal is lost. That is the failure mode to check if denials ever
 * start reading as `upstream_unavailable`.
 */
export function findEgressDenial(error: unknown): SearchProviderError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth += 1) {
    if (isSearchProviderError(current) && current.code === 'policy_denied') {
      return current as SearchProviderError;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** Node's `dns.lookup` shape — the seam a test replaces. */
export type EgressDnsLookup = typeof defaultDnsLookup;

/**
 * Wrap a resolver so every address it returns is validated before use.
 *
 * Always resolves with `all: true` and re-shapes the answer to whatever the
 * caller asked for. Node's `net.connect` passes `all: true` under
 * `autoSelectFamily` and `all: false` otherwise; validating only the address a
 * single-answer lookup happened to pick would leave the others unchecked on the
 * hosts where it matters most.
 */
export function createEgressGuardedLookup(
  policy: SearchEgressPolicy = DEFAULT_SEARCH_EGRESS_POLICY,
  lookupImpl: EgressDnsLookup = defaultDnsLookup,
): EgressDnsLookup {
  const guarded = (
    hostname: string,
    options: unknown,
    callback: (error: Error | null, ...answer: unknown[]) => void,
  ): void => {
    const requestedAll = Boolean((options as { all?: boolean } | undefined)?.all);
    const lookupOptions = { ...(options as object | undefined), all: true as const };

    (lookupImpl as unknown as GuardedLookupImpl)(hostname, lookupOptions, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }

      const entries = Array.isArray(addresses) ? addresses : [];
      if (entries.length === 0) {
        callback(new Error(`no addresses resolved for ${hostname}`));
        return;
      }

      try {
        for (const entry of entries) assertEgressAddressAllowed(entry.address, hostname, policy);
      } catch (denial) {
        callback(denial as Error);
        return;
      }

      if (requestedAll) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    });
  };

  return guarded as unknown as EgressDnsLookup;
}

type GuardedLookupImpl = (
  hostname: string,
  options: { all: true },
  callback: (error: Error | null, addresses: Array<{ address: string; family: number }>) => void,
) => void;

/** Cache key -> dispatcher, so a policy does not build an Agent per request. */
const guardedDispatchers = new Map<string, Dispatcher>();

/**
 * An undici dispatcher that validates every resolved address before connecting.
 *
 * Cached per policy signature: a fresh `Agent` per request would leak
 * connection pools. As in `search/http/proxy.ts`, a superseded dispatcher is
 * never closed — a concurrent request may still be reading through it.
 */
export function createEgressGuardedDispatcher(
  policy: SearchEgressPolicy = DEFAULT_SEARCH_EGRESS_POLICY,
  lookupImpl?: EgressDnsLookup,
): Dispatcher {
  // An injected resolver is a test seam; those dispatchers are never shared.
  if (lookupImpl) {
    return new Agent({ connect: { lookup: createEgressGuardedLookup(policy, lookupImpl) } });
  }

  const signature = JSON.stringify(normalizePolicy(policy));
  const cached = guardedDispatchers.get(signature);
  if (cached) return cached;

  const dispatcher = new Agent({ connect: { lookup: createEgressGuardedLookup(policy) } });
  guardedDispatchers.set(signature, dispatcher);
  return dispatcher;
}

/** Sorted, lowercased allowlist — so two equivalent policies share a cache slot. */
function normalizePolicy(policy: SearchEgressPolicy): { allowedPrivateHosts: string[] } {
  return {
    allowedPrivateHosts: [...(policy.allowedPrivateHosts ?? [])]
      .map(normalizeHostname)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  };
}
