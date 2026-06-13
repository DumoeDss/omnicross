/**
 * Unit tests for the Gemini `generateContent` ingress parser's pure
 * route-match / stream-detection / model-extraction helpers
 * (`provider-proxy-transformer-matrix` slice 2). The full route → pipeline
 * behavior (endpoint transformer + runResponseChain + x-goog-api-key auth) is
 * covered in `ProviderProxy.ingress.test.ts`; this file pins the path parsing.
 *
 * @module provider-proxy/__tests__/geminiGenerateContentIngress.test
 */

import { describe, expect, it } from 'vitest';

import {
  extractGeminiModelFromPath,
  isGeminiGenerateContentRequest,
  isGeminiStreamRequest,
} from '../ingress/geminiGenerateContentIngress';

describe('isGeminiGenerateContentRequest', () => {
  it('matches POST :generateContent and :streamGenerateContent', () => {
    expect(
      isGeminiGenerateContentRequest('POST', '/v1beta/models/gemini-2.5-pro:generateContent'),
    ).toBe(true);
    expect(
      isGeminiGenerateContentRequest(
        'POST',
        '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      ),
    ).toBe(true);
  });

  it('matches regardless of base prefix (endsWith-style segment match)', () => {
    expect(
      isGeminiGenerateContentRequest('POST', '/some/proxy/v1beta/models/m:generateContent'),
    ).toBe(true);
  });

  it('rejects non-POST, missing url, and unrelated paths', () => {
    expect(isGeminiGenerateContentRequest('GET', '/v1beta/models/m:generateContent')).toBe(false);
    expect(isGeminiGenerateContentRequest('POST', undefined)).toBe(false);
    expect(isGeminiGenerateContentRequest('POST', '/v1/chat/completions')).toBe(false);
    expect(isGeminiGenerateContentRequest('POST', '/v1beta/models/m:countTokens')).toBe(false);
  });
});

describe('isGeminiStreamRequest', () => {
  it('is true for :streamGenerateContent and for ?alt=sse', () => {
    expect(isGeminiStreamRequest('/v1beta/models/m:streamGenerateContent')).toBe(true);
    expect(isGeminiStreamRequest('/v1beta/models/m:streamGenerateContent?alt=sse')).toBe(true);
    // Even a non-stream action with alt=sse is treated as stream (defensive).
    expect(isGeminiStreamRequest('/v1beta/models/m:generateContent?alt=sse')).toBe(true);
  });

  it('is false for plain :generateContent without alt=sse', () => {
    expect(isGeminiStreamRequest('/v1beta/models/m:generateContent')).toBe(false);
    expect(isGeminiStreamRequest('/v1beta/models/m:generateContent?foo=bar')).toBe(false);
    expect(isGeminiStreamRequest(undefined)).toBe(false);
  });
});

describe('extractGeminiModelFromPath', () => {
  it('extracts the model between models/ and the :action', () => {
    expect(extractGeminiModelFromPath('/v1beta/models/gemini-2.5-pro:generateContent')).toBe(
      'gemini-2.5-pro',
    );
    expect(
      extractGeminiModelFromPath('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'),
    ).toBe('gemini-2.5-flash');
  });

  it('returns undefined when there is no :action segment', () => {
    expect(extractGeminiModelFromPath('/v1beta/models/gemini-2.5-pro')).toBeUndefined();
    expect(extractGeminiModelFromPath(undefined)).toBeUndefined();
  });
});
