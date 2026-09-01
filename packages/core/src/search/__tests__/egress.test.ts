/**
 * The SSRF egress policy: which targets are refused, which are admitted, and
 * the two layers (URL-level, DNS-at-connect) that have to agree.
 *
 * No network: the address-validation layer is driven through an injected
 * resolver, which is also the only way to test rebinding at all.
 *
 * @module search/__tests__/egress.test
 */

import { isSearchProviderError, SearchProviderError } from '@omnicross/contracts/search-types';
import { request } from 'undici';
import { describe, expect, it } from 'vitest';

import {
  assertEgressAddressAllowed,
  createEgressGuardedDispatcher,
  createEgressGuardedLookup,
  DEFAULT_SEARCH_EGRESS_POLICY,
  findEgressDenial,
  validateEgressUrl,
  type EgressDnsLookup,
  type SearchEgressPolicy,
} from '../egress';

/** Capture the error a call throws, failing loudly if it does not. */
function denialOf(run: () => unknown): SearchProviderError {
  try {
    run();
  } catch (error) {
    if (!isSearchProviderError(error)) throw error;
    return error as SearchProviderError;
  }
  throw new Error('expected the call to be denied, but it was allowed');
}

/** A resolver that answers every hostname with the given addresses. */
function stubLookup(addresses: string[], family = 4): EgressDnsLookup {
  const answer = addresses.map((address) => ({ address, family }));
  return ((_hostname: string, _options: unknown, callback: unknown) => {
    (callback as (error: Error | null, addresses: unknown) => void)(null, answer);
  }) as unknown as EgressDnsLookup;
}

describe('validateEgressUrl — denied classes', () => {
  const DENIED: Array<[string, string]> = [
    ['file:///etc/passwd', 'scheme'],
    ['ftp://files.example.test/pub', 'scheme'],
    ['gopher://example.test/', 'scheme'],
    ['http://127.0.0.1', 'loopback'],
    ['http://127.99.1.2:9000/admin', 'loopback'],
    ['http://[::1]', 'loopback'],
    ['http://localhost:8080', 'loopback'],
    ['http://api.localhost/search', 'loopback'],
    ['http://10.1.2.3', 'private'],
    ['http://172.20.0.1', 'private'],
    ['http://192.168.1.1', 'private'],
    ['http://169.254.169.254/latest/meta-data', 'metadata'],
    ['http://metadata.google.internal', 'metadata'],
    ['http://169.254.10.20/', 'link-local'],
    ['http://[fe80::1]', 'link-local'],
    ['http://[fd00::2]', 'unique-local'],
    ['http://[::ffff:10.0.0.1]', 'private'],
    ['http://0.0.0.0:8080/', 'unspecified'],
    // Trailing-dot FQDN forms. The URL parser strips a trailing dot off IP
    // LITERALS but keeps it on NAMES, so a name denylist that compares raw
    // hostnames is bypassed by one character — and on a proxied connection the
    // name rules are the only defense there is.
    ['http://localhost./x', 'loopback'],
    ['http://api.localhost./x', 'loopback'],
    ['http://metadata.google.internal./computeMetadata/v1/', 'metadata'],
    ['http://LOCALHOST./x', 'loopback'],
    // The parser accepts more than one, so stripping a single dot is not enough.
    ['http://localhost../x', 'loopback'],
    ['http://metadata.google.internal../x', 'metadata'],
    ['http://127.0.0.1./x', 'loopback'],
    ['http://169.254.169.254./x', 'metadata'],
  ];

  it.each(DENIED)('denies %s', (url, expectedClass) => {
    const error = denialOf(() => validateEgressUrl(url));
    expect(error.code).toBe('policy_denied');
    expect(error.details?.egressClass).toBe(expectedClass);
    expect(error.retryable).toBe(false);
  });

  it('denies the alternate IPv4 notations the URL parser normalizes', () => {
    // 2130706433 === 0x7f000001 === 127.0.0.1. A filter that string-matches on
    // "127." misses every one of these; classifying AFTER `new URL()` does not.
    for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/']) {
      const error = denialOf(() => validateEgressUrl(url));
      expect(error.details?.egressClass).toBe('loopback');
    }
  });

  it('denies a bracketed IPv6 literal with a trailing dot as malformed', () => {
    // `new URL('http://[::1]./x')` THROWS — the parser rejects it outright, so
    // there is no hostname to classify and `malformed` is the truthful class,
    // not a gap in the classifier. Refused either way; recorded so the
    // diagnostic is not mistaken for a miss.
    expect(denialOf(() => validateEgressUrl('http://[::1]./x')).details?.egressClass).toBe(
      'malformed',
    );
  });

  it('denies an unparseable or relative target without echoing it', () => {
    const error = denialOf(() => validateEgressUrl('/latest/meta-data?key=secret-value'));
    expect(error.details?.egressClass).toBe('malformed');
    expect(error.message).not.toContain('secret-value');
    expect(error.message).not.toContain('/latest/meta-data');
  });

  it('names the hostname only — never the path, query, or userinfo', () => {
    const error = denialOf(() =>
      validateEgressUrl('http://admin:hunter2@169.254.169.254/latest/meta-data?q=user+query'),
    );
    const serialized = `${error.message} ${JSON.stringify(error.details)}`;
    expect(serialized).toContain('169.254.169.254');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('admin');
    expect(serialized).not.toContain('user+query');
    expect(serialized).not.toContain('/latest/meta-data');
  });

  it('stamps the provider id when one is supplied', () => {
    const error = denialOf(() => validateEgressUrl('http://127.0.0.1', undefined, 'searxng'));
    expect(error.providerId).toBe('searxng');
  });
});

describe('validateEgressUrl — permitted targets', () => {
  it.each([
    'https://api.tavily.com/search',
    'https://s.jina.ai/what%20is%20http',
    'https://r.jina.ai/https%3A%2F%2Fexample.com',
    'https://open.bigmodel.cn/api/paas/v4/web_search',
    'https://api.z.ai/api/paas/v4/web_search',
    'https://cn.bing.com/search?q=test',
    'https://html.duckduckgo.com/html/',
    'http://203.0.113.10/search',
    'https://[2606:4700:4700::1111]/',
  ])('permits %s', (url) => {
    expect(() => validateEgressUrl(url)).not.toThrow();
  });

  it('returns the parsed URL so callers need not re-parse', () => {
    const parsed = validateEgressUrl('https://api.tavily.com/search');
    expect(parsed).toBeInstanceOf(URL);
    expect(parsed.hostname).toBe('api.tavily.com');
  });

  it('accepts an already-parsed URL', () => {
    expect(() => validateEgressUrl(new URL('https://s.jina.ai/q'))).not.toThrow();
    expect(() => validateEgressUrl(new URL('http://10.0.0.5/'))).toThrow();
  });
});

describe('validateEgressUrl — allowlist', () => {
  const policy: SearchEgressPolicy = { allowedPrivateHosts: ['searx.internal.corp'] };

  it('is not what stops an internal NAME — the DNS layer is', () => {
    // Worth pinning, because it is the easiest thing to misread about this
    // module. At the URL layer a bare name carries no address, so
    // `searx.internal.corp` is indistinguishable from any public name and
    // passes whether or not it is allowlisted. What it RESOLVES to is the
    // question, and `assertEgressAddressAllowed` is where that is asked.
    expect(() => validateEgressUrl('http://other.internal.corp', policy)).not.toThrow();
    expect(() => validateEgressUrl('http://other.internal.corp')).not.toThrow();

    const denial = denialOf(() =>
      assertEgressAddressAllowed('10.7.7.7', 'other.internal.corp', policy),
    );
    expect(denial.details?.egressClass).toBe('private');
    expect(() => assertEgressAddressAllowed('10.7.7.7', 'searx.internal.corp', policy)).not.toThrow();
  });

  it('admits exactly the hostname it names — no suffix matching', () => {
    // A subdomain of the allowlisted name is NOT allowlisted: a suffix rule is
    // one attacker-registered subdomain away from admitting anything.
    expect(() =>
      assertEgressAddressAllowed('10.7.7.7', 'evil.searx.internal.corp', policy),
    ).toThrow();
    expect(() => validateEgressUrl('http://192.168.0.10/search', policy)).toThrow();
  });

  it('treats a trailing dot as the same entry on BOTH sides of the allowlist', () => {
    // Normalization is applied to the policy's entries and to the hostname
    // alike, so an operator gets the same result whichever form they write in
    // either place. Deliberate: the alternative — normalizing only the
    // hostname — would make an allowlist entry silently stop matching.
    expect(() =>
      assertEgressAddressAllowed('10.1.1.1', 'searx.internal.corp.', {
        allowedPrivateHosts: ['searx.internal.corp'],
      }),
    ).not.toThrow();
    expect(() =>
      assertEgressAddressAllowed('10.1.1.1', 'searx.internal.corp', {
        allowedPrivateHosts: ['searx.internal.corp.'],
      }),
    ).not.toThrow();
    // And it does NOT become a way to re-admit a name denied by name.
    expect(() =>
      validateEgressUrl('http://localhost./x', { allowedPrivateHosts: ['other.internal'] }),
    ).toThrow();
  });

  it('matches case-insensitively and admits literal private addresses', () => {
    expect(() =>
      validateEgressUrl('http://192.168.7.7:8888/search', {
        allowedPrivateHosts: ['192.168.7.7'],
      }),
    ).not.toThrow();
    expect(() =>
      assertEgressAddressAllowed('10.1.1.1', 'SEARX.Internal.Corp', {
        allowedPrivateHosts: ['searx.internal.CORP'],
      }),
    ).not.toThrow();
  });

  it('does NOT let the allowlist re-open a non-HTTP scheme', () => {
    // The scheme rule is checked before the host rules on purpose: an allowlist
    // is about WHERE a request may go, never about what protocol it speaks.
    const error = denialOf(() =>
      validateEgressUrl('file://searx.internal.corp/etc/passwd', policy),
    );
    expect(error.details?.egressClass).toBe('scheme');
  });

  it('leaves the default policy allowlisting nothing', () => {
    expect(DEFAULT_SEARCH_EGRESS_POLICY.allowedPrivateHosts).toBeUndefined();
    expect(denialOf(() => assertEgressAddressAllowed('10.0.0.1', 'searx.internal.corp')).code).toBe(
      'policy_denied',
    );
  });
});

describe('assertEgressAddressAllowed', () => {
  it('classifies a resolved address independently of the hostname', () => {
    expect(() => assertEgressAddressAllowed('93.184.216.34', 'example.test')).not.toThrow();
    const error = denialOf(() => assertEgressAddressAllowed('127.0.0.1', 'example.test'));
    expect(error.details?.egressClass).toBe('loopback');
    expect(error.details?.egressStage).toBe('dns');
    // The HOSTNAME is what a reader can act on; it is what the message names.
    expect(error.message).toContain('example.test');
  });

  it('admits a private address for an allowlisted hostname', () => {
    const policy: SearchEgressPolicy = { allowedPrivateHosts: ['searx.internal.corp'] };
    expect(() =>
      assertEgressAddressAllowed('10.4.5.6', 'searx.internal.corp', policy),
    ).not.toThrow();
    expect(() => assertEgressAddressAllowed('10.4.5.6', 'searx.other.corp', policy)).toThrow();
  });

  it('denies a resolver answer that is not an address at all', () => {
    expect(denialOf(() => assertEgressAddressAllowed('not-an-address', 'example.test')).code).toBe(
      'policy_denied',
    );
  });
});

describe('createEgressGuardedLookup — DNS re-validation', () => {
  it('blocks a public name that resolves to a denied address', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '192.168.0.5']) {
      const lookup = createEgressGuardedLookup(undefined, stubLookup([address]));
      const error = await new Promise<Error | null>((resolve) => {
        (lookup as unknown as LookupCall)('rebind.example.test', { all: false }, resolve);
      });
      expect(isSearchProviderError(error)).toBe(true);
      expect((error as SearchProviderError).code).toBe('policy_denied');
    }
  });

  it('blocks when ANY resolved address is denied, not just the first', async () => {
    // A rebinding answer commonly puts a public address first so a naive
    // "check answer[0]" filter waves it through.
    const lookup = createEgressGuardedLookup(undefined, stubLookup(['93.184.216.34', '127.0.0.1']));
    const error = await new Promise<Error | null>((resolve) => {
      (lookup as unknown as LookupCall)('rebind.example.test', { all: true }, resolve);
    });
    expect((error as SearchProviderError).code).toBe('policy_denied');
  });

  it('passes public answers through in both callback shapes', async () => {
    const lookup = createEgressGuardedLookup(undefined, stubLookup(['93.184.216.34']));

    const single = await new Promise<unknown[]>((resolve) => {
      (lookup as unknown as LookupCall)('example.test', { all: false }, (...answer) =>
        resolve(answer),
      );
    });
    expect(single).toEqual([null, '93.184.216.34', 4]);

    const all = await new Promise<unknown[]>((resolve) => {
      (lookup as unknown as LookupCall)('example.test', { all: true }, (...answer) =>
        resolve(answer),
      );
    });
    expect(all).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
  });

  it('admits a private answer for an allowlisted hostname', async () => {
    const lookup = createEgressGuardedLookup(
      { allowedPrivateHosts: ['searx.internal.corp'] },
      stubLookup(['10.9.9.9']),
    );
    const answer = await new Promise<unknown[]>((resolve) => {
      (lookup as unknown as LookupCall)('searx.internal.corp', { all: false }, (...values) =>
        resolve(values),
      );
    });
    expect(answer[0]).toBeNull();
  });

  it('propagates a resolver failure unchanged', async () => {
    const failing = ((_host: string, _options: unknown, callback: unknown) => {
      (callback as (error: Error) => void)(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    }) as unknown as EgressDnsLookup;
    const lookup = createEgressGuardedLookup(undefined, failing);
    const error = await new Promise<Error | null>((resolve) => {
      (lookup as unknown as LookupCall)('nope.example.test', {}, resolve);
    });
    expect(error?.message).toBe('ENOTFOUND');
    expect(isSearchProviderError(error)).toBe(false);
  });
});

describe('createEgressGuardedDispatcher', () => {
  it('refuses to connect when the name resolves into a denied class', async () => {
    // The real thing: an undici request through the guarded dispatcher. The
    // socket is never opened because the lookup fails first.
    const dispatcher = createEgressGuardedDispatcher(undefined, stubLookup(['127.0.0.1']));
    let thrown: unknown;
    try {
      await request('http://rebind.example.test/search', { dispatcher });
    } catch (error) {
      thrown = error;
    }

    const denial = findEgressDenial(thrown);
    expect(denial?.code).toBe('policy_denied');
    expect(denial?.details?.egressStage).toBe('dns');
    await dispatcher.close();
  });

  it('caches one dispatcher per policy signature', () => {
    const first = createEgressGuardedDispatcher({ allowedPrivateHosts: ['a.internal'] });
    const same = createEgressGuardedDispatcher({ allowedPrivateHosts: ['A.INTERNAL'] });
    const other = createEgressGuardedDispatcher({ allowedPrivateHosts: ['b.internal'] });
    expect(same).toBe(first);
    expect(other).not.toBe(first);
    // An injected resolver is a test seam, so those are never shared.
    expect(createEgressGuardedDispatcher(undefined, stubLookup(['1.1.1.1']))).not.toBe(
      createEgressGuardedDispatcher(undefined, stubLookup(['1.1.1.1'])),
    );
  });
});

describe('findEgressDenial', () => {
  it('finds the denial undici buried in a cause chain', () => {
    const denial = denialOf(() => validateEgressUrl('http://127.0.0.1'));
    const wrapped = new TypeError('fetch failed', { cause: new Error('connect', { cause: denial }) });
    expect(findEgressDenial(wrapped)).toBe(denial);
  });

  it('returns undefined for unrelated errors and other taxonomy codes', () => {
    expect(findEgressDenial(new Error('boom'))).toBeUndefined();
    expect(findEgressDenial(undefined)).toBeUndefined();
    // A taxonomy error that is not a denial must not be mistaken for one.
    expect(findEgressDenial(new SearchProviderError('timeout', 'too slow'))).toBeUndefined();
  });
});

type LookupCall = (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, ...answer: unknown[]) => void,
) => void;
