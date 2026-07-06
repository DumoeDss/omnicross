/**
 * accountModelMap pure-helper tests (subscription-account-model-map, task 2.1 / 3.1).
 * Covers the CRS dual-format allow-list membership + logical→actual remap:
 * absent ⇒ supports all / no remap; array ⇒ case-insensitive membership; object ⇒
 * keys are the allow-list + values are the actual model; the report helper returns
 * `undefined` on a no-op so the relay forwards the body byte-for-byte.
 */

import { describe, expect, it } from 'vitest';

import {
  accountSupportsModel,
  remapForAccount,
  remapReportForAccount,
} from '../scheduler/accountModelMap';

describe('accountSupportsModel', () => {
  it('absent supportedModels supports every model', () => {
    expect(accountSupportsModel(undefined, 'claude-sonnet-4')).toBe(true);
  });

  it('array is an allow-list (case-insensitive membership)', () => {
    const models = ['claude-sonnet-4', 'claude-opus-4'];
    expect(accountSupportsModel(models, 'claude-sonnet-4')).toBe(true);
    expect(accountSupportsModel(models, 'CLAUDE-OPUS-4')).toBe(true);
    expect(accountSupportsModel(models, 'claude-haiku-4')).toBe(false);
  });

  it('object keys act as the allow-list', () => {
    const map = { 'claude-opus-4': 'claude-opus-4-20250514' };
    expect(accountSupportsModel(map, 'claude-opus-4')).toBe(true);
    expect(accountSupportsModel(map, 'Claude-Opus-4')).toBe(true);
    expect(accountSupportsModel(map, 'claude-sonnet-4')).toBe(false);
  });

  it('matches on the canonical bare id (a "provider,model" ref reduces to model)', () => {
    expect(accountSupportsModel(['claude-opus-4'], 'anthropic,claude-opus-4')).toBe(true);
  });

  it('an empty array/object supports nothing (deliberate deny-all)', () => {
    expect(accountSupportsModel([], 'claude-sonnet-4')).toBe(false);
    expect(accountSupportsModel({}, 'claude-sonnet-4')).toBe(false);
  });
});

describe('remapForAccount', () => {
  it('object with a matching key returns the actual model', () => {
    expect(remapForAccount({ 'claude-opus-4': 'claude-opus-4-20250514' }, 'claude-opus-4')).toBe(
      'claude-opus-4-20250514',
    );
    expect(remapForAccount({ 'claude-opus-4': 'claude-opus-4-20250514' }, 'CLAUDE-OPUS-4')).toBe(
      'claude-opus-4-20250514',
    );
  });

  it('array form / absent / missing key leave the model unchanged', () => {
    expect(remapForAccount(['claude-opus-4'], 'claude-opus-4')).toBe('claude-opus-4');
    expect(remapForAccount(undefined, 'claude-opus-4')).toBe('claude-opus-4');
    expect(remapForAccount({ 'claude-sonnet-4': 'x' }, 'claude-opus-4')).toBe('claude-opus-4');
  });
});

describe('remapReportForAccount', () => {
  it('reports the actual model only when it differs (no-op ⇒ undefined)', () => {
    expect(remapReportForAccount({ 'claude-opus-4': 'claude-opus-4-20250514' }, 'claude-opus-4')).toBe(
      'claude-opus-4-20250514',
    );
    // Array form, absent map, and a self-mapping all report undefined (verbatim body).
    expect(remapReportForAccount(['claude-opus-4'], 'claude-opus-4')).toBeUndefined();
    expect(remapReportForAccount(undefined, 'claude-opus-4')).toBeUndefined();
    expect(remapReportForAccount({ 'claude-opus-4': 'claude-opus-4' }, 'claude-opus-4')).toBeUndefined();
    expect(remapReportForAccount({ x: 'y' }, undefined)).toBeUndefined();
  });
});
