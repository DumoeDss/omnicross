/**
 * validateSupportedModelsBody tests (subscription-account-model-map, task 4.1).
 * The admin write validator accepts null/absent (clear), a NON-EMPTY string[]
 * allow-list of non-blank ids, and a NON-EMPTY flat Record<string,string> map of
 * non-blank keys → non-blank actual models; it rejects any other shape (a
 * non-string/blank element, an empty array/object, a blank/empty remap value) so a
 * malformed body → 400.
 */

import { describe, expect, it } from 'vitest';

import { validateSupportedModelsBody } from '../admin/accountsWrite';

describe('validateSupportedModelsBody', () => {
  it('null/undefined ⇒ clear (undefined value)', () => {
    expect(validateSupportedModelsBody(null)).toEqual({ ok: true, value: undefined });
    expect(validateSupportedModelsBody(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('a non-empty string[] allow-list is accepted verbatim', () => {
    expect(validateSupportedModelsBody(['a', 'b'])).toEqual({ ok: true, value: ['a', 'b'] });
  });

  it('a non-empty flat string→string map is accepted verbatim', () => {
    expect(validateSupportedModelsBody({ a: 'X', b: 'Y' })).toEqual({ ok: true, value: { a: 'X', b: 'Y' } });
  });

  it('rejects an empty array/object (a "supports nothing" footgun)', () => {
    expect(validateSupportedModelsBody([])).toEqual({ ok: false });
    expect(validateSupportedModelsBody({})).toEqual({ ok: false });
  });

  it('rejects a blank array element or a blank/empty remap value or key', () => {
    expect(validateSupportedModelsBody(['a', '  '])).toEqual({ ok: false });
    expect(validateSupportedModelsBody({ a: '' })).toEqual({ ok: false });
    expect(validateSupportedModelsBody({ a: '   ' })).toEqual({ ok: false });
    expect(validateSupportedModelsBody({ '': 'X' })).toEqual({ ok: false });
  });

  it('rejects a non-string array element or object value', () => {
    expect(validateSupportedModelsBody(['a', 1])).toEqual({ ok: false });
    expect(validateSupportedModelsBody({ a: 2 })).toEqual({ ok: false });
    expect(validateSupportedModelsBody('a-string')).toEqual({ ok: false });
    expect(validateSupportedModelsBody(42)).toEqual({ ok: false });
  });
});
