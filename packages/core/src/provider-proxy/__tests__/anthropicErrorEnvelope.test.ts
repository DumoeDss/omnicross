/**
 * Unit tests for the Anthropic local-error envelope mechanism
 * (`claude-api-routing-errors`, capability anthropic-local-errors).
 *
 * Table-drives the status → `error.type` mapping (requirements §6) and pins the
 * writer mechanics: details fold into `error`, headers pass through,
 * `headersSent` short-circuits, and the mark flips the two resident writers
 * (`writeError` / `writeBoundAccountError`) between the legacy
 * `provider_proxy_error` shape (byte-identical) and the Anthropic shape.
 *
 * @module provider-proxy/__tests__/anthropicErrorEnvelope.test
 */

import type http from 'node:http';

import { describe, expect, it } from 'vitest';

import { BoundAccountSelectionError } from '../../pipeline/BoundAccountSelectionError';
import {
  anthropicErrorTypeForStatus,
  isAnthropicProtocolResponse,
  markAnthropicProtocolResponse,
  writeAnthropicError,
} from '../ingress/anthropicErrorEnvelope';
import { writeBoundAccountError, writeError } from '../ingress/providerProxyShared';

/** A minimal ServerResponse-shaped recorder. */
class MockRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = '';
  headersSent = false;
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    this.headersSent = true;
    return this;
  }
  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

describe('anthropicErrorTypeForStatus (table)', () => {
  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'rate_limit_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [429, 'rate_limit_error'],
    [499, 'api_error'],
    [501, 'not_found_error'],
    [502, 'api_error'],
    [503, 'api_error'],
    // Unmapped statuses degrade to api_error.
    [500, 'api_error'],
    [418, 'api_error'],
  ])('maps %d → %s', (status, expected) => {
    expect(anthropicErrorTypeForStatus(status)).toBe(expected);
  });
});

describe('writeAnthropicError', () => {
  it('writes the official shape with details folded into error', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    writeAnthropicError(r, 402, 'Cost limit reached', {}, { scope: 'daily', limitUsd: 1, spentUsd: 2 });
    expect(r.statusCode).toBe(402);
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(r.body)).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Cost limit reached',
        scope: 'daily',
        limitUsd: 1,
        spentUsd: 2,
      },
    });
  });

  it('passes extra headers through (Retry-After)', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    writeAnthropicError(r, 429, 'Rate limit exceeded', { 'Retry-After': '7' });
    expect(r.headers['Retry-After']).toBe('7');
    expect((JSON.parse(r.body) as { error: { type: string } }).error.type).toBe('rate_limit_error');
  });

  it('silently no-ops once headers were sent (no truncate, no throw)', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    r.writeHead(200, {});
    r.body = 'partial';
    writeAnthropicError(r, 500, 'late error');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('partial');
  });
});

describe('mark pair', () => {
  it('mark makes isAnthropicProtocolResponse true; unmarked stays false', () => {
    const marked = new MockRes() as unknown as http.ServerResponse;
    const plain = new MockRes() as unknown as http.ServerResponse;
    expect(isAnthropicProtocolResponse(marked)).toBe(false);
    markAnthropicProtocolResponse(marked);
    expect(isAnthropicProtocolResponse(marked)).toBe(true);
    expect(isAnthropicProtocolResponse(plain)).toBe(false);
  });
});

describe('writeError mark-awareness', () => {
  it('unmarked → legacy provider_proxy_error byte shape', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    writeError(r, 502, 'boom');
    expect(r.body).toBe(JSON.stringify({ error: { type: 'provider_proxy_error', message: 'boom' } }));
  });

  it('marked → Anthropic shape with the mapped type', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    markAnthropicProtocolResponse(r);
    writeError(r, 502, 'boom');
    expect(JSON.parse(r.body)).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'boom' },
    });
  });
});

describe('writeBoundAccountError mark-awareness', () => {
  it('unmarked → legacy shape with code/reason inside the error object', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    writeBoundAccountError(r, new BoundAccountSelectionError('claude', 'not-found'));
    expect(JSON.parse(r.body)).toEqual({
      error: {
        type: 'provider_proxy_error',
        code: 'bound_account_unavailable',
        reason: 'not-found',
        message: 'Bound subscription account was not found',
      },
    });
  });

  it('marked → Anthropic shape, code/reason preserved, Retry-After kept', () => {
    const r = new MockRes() as unknown as http.ServerResponse;
    markAnthropicProtocolResponse(r);
    const resumeAt = new Date(Date.now() + 30_000).toISOString();
    writeBoundAccountError(r, new BoundAccountSelectionError('claude', 'allowance-paused', resumeAt));
    expect(r.statusCode).toBe(429);
    expect(r.headers['Retry-After']).toBeDefined();
    expect(JSON.parse(r.body)).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Bound subscription account is paused by the allowance policy',
        code: 'bound_account_unavailable',
        reason: 'allowance-paused',
      },
    });
  });
});
