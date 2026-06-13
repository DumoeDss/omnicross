/**
 * Focused unit tests for `OAuthPassThroughAuth` (Phase 2, task 4.4).
 *
 * Asserts `applyHeaders` is a NO-OP: it neither adds nor removes headers,
 * preserving the SDK's own Authorization bearer verbatim.
 */

import { describe, expect, it } from 'vitest';

import { OAuthPassThroughAuth } from '../OAuthPassThroughAuth';

const hints = { upstreamUrl: 'https://api.anthropic.com/v1/messages', model: 'claude-x' };

describe('OAuthPassThroughAuth.applyHeaders', () => {
  it('is a no-op — leaves the SDK-supplied bearer untouched', () => {
    const auth = new OAuthPassThroughAuth();
    const headers: Record<string, string> = {
      Authorization: 'Bearer sdk-supplied-token',
      'content-type': 'application/json',
    };
    const before = { ...headers };

    auth.applyHeaders(headers, hints);

    expect(headers).toEqual(before);
  });

  it('does not add an auth header to an empty header object', () => {
    const auth = new OAuthPassThroughAuth();
    const headers: Record<string, string> = {};
    auth.applyHeaders(headers, hints);
    expect(headers).toEqual({});
  });
});
