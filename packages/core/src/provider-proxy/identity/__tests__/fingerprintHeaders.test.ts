/**
 * fingerprintHeaders — pure whitelist/exclusion + the outbound merge +
 * `applyFingerprint` composition (subscription-client-fingerprint #7).
 *
 * `applyFingerprint` is the EXACT code the claude same-format relay runs on its
 * built `{ content-type, authorization }` header bag, so these cases are the
 * relay's own behavior: disabled ⇒ byte-identical; enabled ⇒ replay the frozen
 * identity without overriding auth/content-type; uncaptured ⇒ no fabricated
 * stainless (at most the UA baseline).
 */

import { describe, expect, it } from 'vitest';

import {
  applyFingerprint,
  captureCallerIdentity,
  compareCliSemver,
  DEFAULT_CLAUDE_CLI_VERSION_FLOOR,
  extractFingerprintHeaders,
  floorClaudeCliUserAgent,
  isValidCliSemver,
  mergeFrozenIdentity,
  refreshNonStainless,
  sanitizeFrozenHeaders,
} from '../fingerprintHeaders';
import { SubscriptionIdentityStore } from '../SubscriptionIdentityStore';

/** A real-Claude-Code-shaped incoming header bag (auth/cookie present too). */
function claudeCodeHeaders(): Record<string, string | string[] | undefined> {
  return {
    'user-agent': 'claude-cli/1.2.3 (external, cli)',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'x-stainless-arch': 'arm64',
    'x-stainless-runtime': 'node',
    'x-stainless-package-version': '0.30.1',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'x-app': 'cli',
    // Secrets — must NEVER be captured:
    authorization: 'Bearer sk-ant-oat01-SECRET',
    'x-api-key': 'sk-ant-SECRET',
    cookie: 'session=SECRET',
  };
}

/** The relay's built header bag `applyFingerprint` merges the identity into. */
function relayBaseHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer live-oauth-token',
  };
}

describe('extractFingerprintHeaders', () => {
  it('captures the whitelisted fingerprint headers, lowercased', () => {
    const bag = extractFingerprintHeaders(claudeCodeHeaders());
    expect(bag['user-agent']).toBe('claude-cli/1.2.3 (external, cli)');
    expect(bag['x-stainless-lang']).toBe('js');
    expect(bag['x-stainless-package-version']).toBe('0.30.1');
    expect(bag['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(bag['anthropic-version']).toBe('2023-06-01');
    expect(bag['x-app']).toBe('cli');
  });

  it('NEVER captures authorization / x-api-key / cookie (the token/secret)', () => {
    const bag = extractFingerprintHeaders(claudeCodeHeaders());
    expect(bag['authorization']).toBeUndefined();
    expect(bag['x-api-key']).toBeUndefined();
    expect(bag['cookie']).toBeUndefined();
    // No captured VALUE is a secret string either.
    const values = Object.values(bag).join('|').toLowerCase();
    expect(values).not.toContain('sk-ant');
    expect(values).not.toContain('session=');
  });

  it('drops non-whitelisted headers and joins array (duplicate) values', () => {
    const bag = extractFingerprintHeaders({
      'x-forwarded-for': '10.0.0.1',
      host: 'api.anthropic.com',
      'anthropic-beta': ['a', 'b'],
    });
    expect(bag['x-forwarded-for']).toBeUndefined();
    expect(bag['host']).toBeUndefined();
    expect(bag['anthropic-beta']).toBe('a, b');
  });
});

describe('sanitizeFrozenHeaders', () => {
  it('hard-excludes auth/secret + protected-outbound even if handed in', () => {
    const clean = sanitizeFrozenHeaders({
      'X-Stainless-Lang': 'js',
      Authorization: 'Bearer secret',
      'x-api-key': 'sk',
      cookie: 'c',
      'content-type': 'application/json',
      'user-agent': 'ua',
      empty: '',
    });
    expect(clean).toEqual({ 'x-stainless-lang': 'js', 'user-agent': 'ua' });
  });
});

describe('mergeFrozenIdentity', () => {
  it('never overwrites authorization / content-type, nor a present header', () => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: 'Bearer live-oauth',
      'user-agent': 'preset',
    };
    mergeFrozenIdentity(headers, {
      'content-type': 'text/evil',
      authorization: 'Bearer stolen',
      'user-agent': 'frozen-ua',
      'x-stainless-lang': 'js',
    });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer live-oauth');
    expect(headers['user-agent']).toBe('preset');
    expect(headers['x-stainless-lang']).toBe('js');
  });
});

describe('refreshNonStainless', () => {
  it('keeps stainless frozen-stable and refreshes non-stainless from the new bag', () => {
    const frozen = {
      'x-stainless-lang': 'js',
      'x-stainless-os': 'MacOS',
      'user-agent': 'old-ua',
      'anthropic-beta': 'old-beta',
    };
    const incoming = {
      'x-stainless-lang': 'python', // ignored — stainless stays frozen
      'x-stainless-new': 'nope', // ignored — no new stainless after freeze
      'user-agent': 'new-ua',
      'x-app': 'cli',
    };
    const out = refreshNonStainless(frozen, incoming);
    expect(out['x-stainless-lang']).toBe('js');
    expect(out['x-stainless-os']).toBe('MacOS');
    expect(out['x-stainless-new']).toBeUndefined();
    expect(out['user-agent']).toBe('new-ua');
    expect(out['anthropic-beta']).toBe('old-beta'); // kept (new bag omitted it)
    expect(out['x-app']).toBe('cli'); // added
  });
});

describe('captureCallerIdentity (the ingress gate)', () => {
  it('disabled ⇒ returns undefined (extraction skipped, no wasted work)', () => {
    const store = new SubscriptionIdentityStore({ enabled: false });
    expect(captureCallerIdentity(store, claudeCodeHeaders())).toBeUndefined();
  });

  it('enabled ⇒ returns the whitelisted bag (identical to extractFingerprintHeaders)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    const bag = captureCallerIdentity(store, claudeCodeHeaders());
    expect(bag).toEqual(extractFingerprintHeaders(claudeCodeHeaders()));
    expect(bag?.['authorization']).toBeUndefined();
  });
});

describe('applyFingerprint (the relay composition)', () => {

  it('disabled ⇒ strict no-op (outbound headers byte-identical)', () => {
    const store = new SubscriptionIdentityStore({ enabled: false });
    const headers = relayBaseHeaders();
    applyFingerprint(store, headers, 'claude', 'acc-1', extractFingerprintHeaders(claudeCodeHeaders()));
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer live-oauth-token' });
  });

  it('no account id ⇒ strict no-op even when enabled', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    const headers = relayBaseHeaders();
    applyFingerprint(store, headers, 'claude', undefined, extractFingerprintHeaders(claudeCodeHeaders()));
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer live-oauth-token' });
  });

  it('enabled ⇒ captures then replays the frozen identity, never touching auth/content-type', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    const caller = extractFingerprintHeaders(claudeCodeHeaders());

    // First request captures-then-replays (its own real headers). The 1.2.3 UA is
    // below the default floor ⇒ raised (see the floor describe below).
    const first = relayBaseHeaders();
    applyFingerprint(store, first, 'claude', 'acc-1', caller);
    expect(first['x-stainless-lang']).toBe('js');
    expect(first['user-agent']).toBe(`claude-cli/${DEFAULT_CLAUDE_CLI_VERSION_FLOOR} (external, cli)`);
    expect(first['authorization']).toBe('Bearer live-oauth-token');
    expect(first['content-type']).toBe('application/json');

    // A SUBSEQUENT request with NO caller headers still replays the frozen set.
    const later = relayBaseHeaders();
    applyFingerprint(store, later, 'claude', 'acc-1', undefined);
    expect(later['x-stainless-lang']).toBe('js');
    expect(later['x-stainless-package-version']).toBe('0.30.1');
    expect(later['user-agent']).toBe(`claude-cli/${DEFAULT_CLAUDE_CLI_VERSION_FLOOR} (external, cli)`);
    // And NEVER an auth/secret value:
    expect(Object.values(later).join('|').toLowerCase()).not.toContain('sk-ant');
  });

  it('per-account isolation: account A identity never appears on account B', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-A', { 'x-stainless-lang': 'js-A' });

    const bHeaders = relayBaseHeaders();
    applyFingerprint(store, bHeaders, 'claude', 'acc-B', undefined);
    expect(bHeaders['x-stainless-lang']).toBeUndefined();
    expect(bHeaders).toEqual({ 'content-type': 'application/json', authorization: 'Bearer live-oauth-token' });
  });

  it('uncaptured account ⇒ NO fabricated stainless (no UA baseline configured ⇒ no-op)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true });
    const headers = relayBaseHeaders();
    applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
    expect(headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer live-oauth-token' });
    // No x-stainless-* invented.
    expect(Object.keys(headers).some((k) => k.startsWith('x-stainless-'))).toBe(false);
  });

  it('uncaptured account + UA baseline ⇒ ONLY user-agent applied (never a stainless value)', () => {
    const store = new SubscriptionIdentityStore({ enabled: true, ua: 'omnicross-baseline/1.0' });
    const headers = relayBaseHeaders();
    applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
    expect(headers['user-agent']).toBe('omnicross-baseline/1.0');
    expect(Object.keys(headers).some((k) => k.startsWith('x-stainless-'))).toBe(false);
  });

  it('a request carrying NO fingerprint headers freezes nothing ⇒ falls back to UA baseline', () => {
    const store = new SubscriptionIdentityStore({ enabled: true, ua: 'baseline/1' });
    const headers = relayBaseHeaders();
    applyFingerprint(store, headers, 'claude', 'acc-1', {}); // empty caller bag
    expect(headers['user-agent']).toBe('baseline/1');
    expect(store.hasIdentity('claude', 'acc-1')).toBe(false);
  });
});

describe('claude-cli version floor (claude-cli-version-floor)', () => {
  describe('isValidCliSemver / compareCliSemver', () => {
    it('accepts only strict three-part numeric semver', () => {
      expect(isValidCliSemver('2.1.280')).toBe(true);
      expect(isValidCliSemver(' 2.1.280 ')).toBe(true); // trimmed
      expect(isValidCliSemver('2.1')).toBe(false);
      expect(isValidCliSemver('v2.1.280')).toBe(false);
      expect(isValidCliSemver('2.1.280-local')).toBe(false);
      expect(isValidCliSemver('2.1.280+build')).toBe(false);
      expect(isValidCliSemver('')).toBe(false);
      expect(isValidCliSemver(undefined)).toBe(false);
    });

    it('compares numeric triples, not strings', () => {
      expect(compareCliSemver('2.1.9', '2.1.10')).toBeLessThan(0);
      expect(compareCliSemver('2.2.0', '2.1.280')).toBeGreaterThan(0);
      expect(compareCliSemver('2.1.280', '2.1.280')).toBe(0);
      expect(compareCliSemver('10.0.0', '9.9.9')).toBeGreaterThan(0);
    });
  });

  describe('floorClaudeCliUserAgent', () => {
    it('raises an older claude-cli version, preserving product + suffix verbatim', () => {
      expect(floorClaudeCliUserAgent('claude-cli/1.2.3 (external, cli)', '2.1.280')).toEqual({
        ua: 'claude-cli/2.1.280 (external, cli)',
        changed: true,
      });
      expect(floorClaudeCliUserAgent('claude-cli/2.0.53', '2.1.280')).toEqual({
        ua: 'claude-cli/2.1.280',
        changed: true,
      });
    });

    it('NEVER lowers: an equal/newer version is returned unchanged', () => {
      expect(floorClaudeCliUserAgent('claude-cli/2.1.280 (external, cli)', '2.1.280')).toEqual({
        ua: 'claude-cli/2.1.280 (external, cli)',
        changed: false,
      });
      expect(floorClaudeCliUserAgent('claude-cli/3.0.0 (external, cli)', '2.1.280')?.changed).toBe(false);
    });

    it('leaves non-claude-cli and absent UAs alone (undefined)', () => {
      expect(floorClaudeCliUserAgent('omnicross-baseline/1.0', '2.1.280')).toBeUndefined();
      expect(floorClaudeCliUserAgent(undefined, '2.1.280')).toBeUndefined();
      // Not a version-shaped claude-cli UA either — do not guess a rewrite.
      expect(floorClaudeCliUserAgent('claude-cli/dev', '2.1.280')).toBeUndefined();
    });
  });

  describe('applyFingerprint floors the REPLAYED user-agent', () => {
    it('stale frozen UA (captured with an old CLI) is raised to the configured floor', () => {
      const store = new SubscriptionIdentityStore({ enabled: true, cliVersionFloor: '2.1.200' });
      applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-1', {
        'user-agent': 'claude-cli/2.0.10 (external, cli)',
      });
      const headers = relayBaseHeaders();
      applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
      expect(headers['user-agent']).toBe('claude-cli/2.1.200 (external, cli)');
    });

    it('frozen UA already at/above the floor replays byte-identically', () => {
      const store = new SubscriptionIdentityStore({ enabled: true, cliVersionFloor: '2.1.200' });
      applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-1', {
        'user-agent': 'claude-cli/9.9.9 (external, cli)',
      });
      const headers = relayBaseHeaders();
      applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
      expect(headers['user-agent']).toBe('claude-cli/9.9.9 (external, cli)');
    });

    it('the UA baseline is floored too when it names claude-cli; other products untouched', () => {
      const store = new SubscriptionIdentityStore({
        enabled: true,
        ua: 'claude-cli/2.0.53 (external, cli)',
        cliVersionFloor: '2.1.280',
      });
      const headers = relayBaseHeaders();
      applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
      expect(headers['user-agent']).toBe('claude-cli/2.1.280 (external, cli)');

      const other = new SubscriptionIdentityStore({
        enabled: true,
        ua: 'omnicross-baseline/1.0',
        cliVersionFloor: '2.1.280',
      });
      const otherHeaders = relayBaseHeaders();
      applyFingerprint(other, otherHeaders, 'claude', 'acc-1', undefined);
      expect(otherHeaders['user-agent']).toBe('omnicross-baseline/1.0');
    });

    it('default floor: the built-in pin applies with no operator override', () => {
      const store = new SubscriptionIdentityStore({ enabled: true });
      applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-1', {
        'user-agent': 'claude-cli/1.2.3 (external, cli)',
      });
      const headers = relayBaseHeaders();
      applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
      expect(headers['user-agent']).toBe(`claude-cli/${DEFAULT_CLAUDE_CLI_VERSION_FLOOR} (external, cli)`);
    });

    it('floors under the original key spelling (case-insensitive lookup)', () => {
      const store = new SubscriptionIdentityStore({ enabled: true, cliVersionFloor: '2.1.280' });
      applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-1', {
        'user-agent': 'claude-cli/2.0.0 (external, cli)',
      });
      const headers: Record<string, string> = {
        ...relayBaseHeaders(),
        'User-Agent': 'claude-cli/2.0.0 (external, cli)',
      };
      applyFingerprint(store, headers, 'claude', 'acc-1', undefined);
      expect(headers['User-Agent']).toBe('claude-cli/2.1.280 (external, cli)');
      expect(headers['user-agent']).toBeUndefined();
    });

    it('the frozen STORE keeps the honest captured bytes (floor is replay-only)', () => {
      const store = new SubscriptionIdentityStore({ enabled: true, cliVersionFloor: '2.1.280' });
      applyFingerprint(store, relayBaseHeaders(), 'claude', 'acc-1', {
        'user-agent': 'claude-cli/2.0.0 (external, cli)',
      });
      expect(store.replay('claude', 'acc-1')?.['user-agent']).toBe('claude-cli/2.0.0 (external, cli)');
    });
  });
});
