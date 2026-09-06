/**
 * extraHeaders merge pins — the static identity-header seam that lets a
 * provider row/gateway carry a hard client-identity contract (the motivating
 * case: the Cline gateway 403s any request missing its client header set).
 *
 * @module completion/__tests__/headerBuilderExtraHeaders.test
 */

import { describe, expect, it } from 'vitest';

import type { LLMProvider } from '@omnicross/contracts/llm-config';

import {
  EXTRA_HEADER_RESERVED_NAMES,
  expandHeaderPlaceholder,
  getProviderHeaders,
  mergeExtraHeaders,
} from '../header-builder';

const BASE: LLMProvider = {
  id: 'cline-pass',
  name: 'Cline',
  apiFormat: 'openai',
  api_base_url: 'https://api.cline.bot/api/v1',
  api_key: 'sk-1',
  models: ['cline-pass/glm-5.3'],
  enabled: true,
};

describe('getProviderHeaders extraHeaders', () => {
  it('merges the static identity set over the openai base', () => {
    const headers = getProviderHeaders(
      { ...BASE, extraHeaders: { 'X-CLIENT-TYPE': 'cline-sdk', 'X-Title': 'Cline' } },
      'sk-1',
    );
    expect(headers['Authorization']).toBe('Bearer sk-1');
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk');
    expect(headers['X-Title']).toBe('Cline');
  });

  it('expands {{platform}} and expands nothing else', () => {
    const headers = getProviderHeaders(
      { ...BASE, extraHeaders: { 'X-PLATFORM': '{{platform}}', 'X-Literal': '{{notatoken}}' } },
      'sk-1',
    );
    expect(headers['X-PLATFORM']).toBe(process.platform);
    expect(headers['X-Literal']).toBe('{{notatoken}}');
    expect(expandHeaderPlaceholder('{{platform}}/{{platform}}')).toBe(
      `${process.platform}/${process.platform}`,
    );
  });

  it('re-enforces the reserved-name set even for a hand-built map', () => {
    const headers = getProviderHeaders(
      {
        ...BASE,
        extraHeaders: {
          Authorization: 'Bearer smuggled',
          'X-API-KEY': 'smuggled',
          Cookie: 'session=1',
          'Content-Type': 'text/plain',
          'X-CLIENT-TYPE': 'cline-sdk',
        },
      },
      'sk-1',
    );
    expect(headers['Authorization']).toBe('Bearer sk-1'); // key-derived wins
    expect(headers['X-API-KEY']).toBeUndefined();
    expect(headers['Cookie']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json'); // framing wins
    expect(headers['X-CLIENT-TYPE']).toBe('cline-sdk');
  });

  it('leaves a provider without extraHeaders byte-identical', () => {
    expect(getProviderHeaders(BASE, 'sk-1')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-1',
    });
  });
});

describe('mergeExtraHeaders', () => {
  it('returns the same object for absent/empty extras', () => {
    const base = { 'Content-Type': 'application/json' };
    expect(mergeExtraHeaders(base, undefined)).toBe(base);
    expect(mergeExtraHeaders(base, {})).toBe(base);
  });

  it('exposes the canonical reserved set', () => {
    expect(EXTRA_HEADER_RESERVED_NAMES.has('authorization')).toBe(true);
    expect(EXTRA_HEADER_RESERVED_NAMES.has('x-api-key')).toBe(true);
    expect(EXTRA_HEADER_RESERVED_NAMES.has('x-client-type')).toBe(false);
  });
});
