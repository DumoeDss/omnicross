/**
 * Unit tests for `normalizeDoubledEndpointPath` (Task 3 — doubled request path
 * self-heal). The helper collapses a repeated `/v1/<endpoint>` suffix left by
 * clients whose baseUrl already ends in the endpoint path.
 *
 * @module outbound-api/__tests__/normalizeDoubledEndpointPath.test
 */

import { describe, expect, it } from 'vitest';

import { normalizeDoubledEndpointPath } from '../OutboundApiServer';

describe('normalizeDoubledEndpointPath', () => {
  it('collapses a doubled /v1/messages suffix', () => {
    expect(normalizeDoubledEndpointPath('/v1/messages/v1/messages')).toBe('/v1/messages');
  });

  it('collapses a doubled /v1/responses suffix', () => {
    expect(normalizeDoubledEndpointPath('/v1/responses/v1/responses')).toBe('/v1/responses');
  });

  it('collapses a doubled /v1/chat/completions suffix', () => {
    expect(normalizeDoubledEndpointPath('/v1/chat/completions/v1/chat/completions')).toBe(
      '/v1/chat/completions',
    );
  });

  it('leaves a normal (non-doubled) path unchanged', () => {
    expect(normalizeDoubledEndpointPath('/v1/messages')).toBe('/v1/messages');
  });

  it('preserves the query string when collapsing', () => {
    expect(normalizeDoubledEndpointPath('/v1/messages/v1/messages?x=1')).toBe(
      '/v1/messages?x=1',
    );
  });

  it('preserves the query string on a non-doubled path', () => {
    expect(normalizeDoubledEndpointPath('/v1/messages?beta=true')).toBe('/v1/messages?beta=true');
  });

  it('leaves /health unchanged', () => {
    expect(normalizeDoubledEndpointPath('/health')).toBe('/health');
  });

  it('leaves /healthz unchanged', () => {
    expect(normalizeDoubledEndpointPath('/healthz')).toBe('/healthz');
  });

  it('leaves /admin/* paths unchanged', () => {
    expect(normalizeDoubledEndpointPath('/admin/keys')).toBe('/admin/keys');
  });

  it('leaves the Gemini :generateContent route unchanged', () => {
    expect(
      normalizeDoubledEndpointPath('/v1beta/models/gemini-2.5-pro:generateContent'),
    ).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
  });

  it('leaves the voucher redeem route unchanged', () => {
    expect(normalizeDoubledEndpointPath('/redeem')).toBe('/redeem');
  });
});
