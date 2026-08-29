import { describe, expect, it } from 'vitest';

import { deriveResponsesCompactUrl } from '../responsesUrl';

describe('deriveResponsesCompactUrl', () => {
  it.each([
    ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses/compact'],
    ['https://chatgpt.com/backend-api/codex/responses?feature=1', 'https://chatgpt.com/backend-api/codex/responses/compact?feature=1'],
    ['https://relay.test/arbitrary/prefix/responses/?a=1&b=two#fragment', 'https://relay.test/arbitrary/prefix/responses/compact?a=1&b=two#fragment'],
  ])('derives compact from %s', (createUrl, compactUrl) => {
    expect(deriveResponsesCompactUrl(createUrl)).toBe(compactUrl);
  });

  it('rejects a non-Responses endpoint without guessing a root path', () => {
    expect(() => deriveResponsesCompactUrl('https://relay.test/v1/chat/completions')).toThrow(
      expect.objectContaining({ code: 'invalid_upstream_url', status: 502 }),
    );
  });
});
