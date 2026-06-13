import { describe, expect, it } from 'vitest';

import {
  EXTENDED_CONTEXT_BETA,
  injectExtendedContextBeta,
} from '../anthropicBetaInject';

describe('injectExtendedContextBeta', () => {
  it('does nothing when useExtendedContext is false', () => {
    const headers: Record<string, string> = {};
    injectExtendedContextBeta(headers, 'claude-opus-4-7', false);
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('adds the flag as anthropic-beta header when capable + flag set', () => {
    const headers: Record<string, string> = {};
    injectExtendedContextBeta(headers, 'claude-opus-4-7', true);
    expect(headers['anthropic-beta']).toBe(EXTENDED_CONTEXT_BETA);
  });

  it('is idempotent — double-call still has exactly one entry', () => {
    const headers: Record<string, string> = {};
    injectExtendedContextBeta(headers, 'claude-opus-4-7', true);
    injectExtendedContextBeta(headers, 'claude-opus-4-7', true);
    expect(headers['anthropic-beta']).toBe(EXTENDED_CONTEXT_BETA);
  });

  it('does not inject when model is outside the 1M-capable allowlist', () => {
    const headers: Record<string, string> = {};
    injectExtendedContextBeta(headers, 'claude-haiku-4-5', true);
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('preserves existing anthropic-beta entries when appending', () => {
    const headers: Record<string, string> = {
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };
    injectExtendedContextBeta(headers, 'claude-opus-4-6', true);
    expect(headers['anthropic-beta']).toBe(
      `prompt-caching-2024-07-31,${EXTENDED_CONTEXT_BETA}`,
    );
  });

  it('keeps the existing header unchanged when the flag is already present', () => {
    const headers: Record<string, string> = {
      'anthropic-beta': `prompt-caching-2024-07-31,${EXTENDED_CONTEXT_BETA}`,
    };
    injectExtendedContextBeta(headers, 'claude-sonnet-4-6', true);
    expect(headers['anthropic-beta']).toBe(
      `prompt-caching-2024-07-31,${EXTENDED_CONTEXT_BETA}`,
    );
  });

  it('handles whitespace in existing comma-separated values', () => {
    const headers: Record<string, string> = {
      'anthropic-beta': 'foo-beta, bar-beta , baz-beta',
    };
    injectExtendedContextBeta(headers, 'claude-opus-4-7', true);
    expect(headers['anthropic-beta']).toBe(
      `foo-beta,bar-beta,baz-beta,${EXTENDED_CONTEXT_BETA}`,
    );
  });

  it('absorbs a case-variant header name (e.g. Anthropic-Beta)', () => {
    const headers: Record<string, string> = {
      'Anthropic-Beta': 'existing-beta',
    };
    injectExtendedContextBeta(headers, 'claude-opus-4-7', true);
    // Case-variant deleted, canonical lowercase emitted
    expect(headers['Anthropic-Beta']).toBeUndefined();
    expect(headers['anthropic-beta']).toBe(
      `existing-beta,${EXTENDED_CONTEXT_BETA}`,
    );
  });

  it('handles all three 1M-capable models', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]) {
      const headers: Record<string, string> = {};
      injectExtendedContextBeta(headers, model, true);
      expect(headers['anthropic-beta']).toBe(EXTENDED_CONTEXT_BETA);
    }
  });
});
