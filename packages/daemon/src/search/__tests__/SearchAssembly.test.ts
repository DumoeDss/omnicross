/**
 * SearchAssembly's egress-proxy wiring.
 *
 * Search transports used to read ONLY `HTTP_PROXY`/`HTTPS_PROXY` env vars, so a
 * daemon started from the desktop app (no proxy env) searched direct even while
 * LLM upstream traffic followed `server.proxy.global`. The fix routes search
 * through the SAME `fetchUpstream` layered resolver; these tests pin the two
 * properties that make that safe: no registered resolver means the env-var
 * baseline (CLI/standalone core use), and a registered resolver is consulted
 * per URL (its own loopback/`NO_PROXY` verdicts).
 *
 * @module daemon/search/__tests__/SearchAssembly.test
 */

import { setUpstreamProxyResolver } from '@omnicross/core/pipeline/upstreamFetch';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveSearchUpstreamDispatcher } from '../SearchAssembly';

describe('resolveSearchUpstreamDispatcher', () => {
  afterEach(() => {
    setUpstreamProxyResolver(null);
  });

  it('returns undefined without a registered resolver — the env-var baseline', () => {
    expect(resolveSearchUpstreamDispatcher('https://html.duckduckgo.com/html/')).toBeUndefined();
  });

  it('routes through the registered layered resolver, per URL', () => {
    const seen: string[] = [];
    setUpstreamProxyResolver((ctx) => {
      seen.push(ctx.url ?? '');
      return ctx.url === 'https://html.duckduckgo.com/html/'
        ? { url: 'socks5://127.0.0.1:7890' }
        : undefined;
    });

    expect(resolveSearchUpstreamDispatcher('https://html.duckduckgo.com/html/')).toBeDefined();
    // A target the resolver declines (loopback, NO_PROXY, no matching layer)
    // stays direct — the transports' env layer then applies unchanged.
    expect(resolveSearchUpstreamDispatcher('http://127.0.0.1:8766/')).toBeUndefined();
    expect(seen).toEqual(['https://html.duckduckgo.com/html/', 'http://127.0.0.1:8766/']);
  });
});
