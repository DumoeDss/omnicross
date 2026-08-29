/**
 * Unit tests for the zero-dependency PDF text extractor
 * (`claude-api-transform-fidelity`, R7 / design D4). Fixtures are CONSTRUCTED
 * minimal PDFs (deflate-compressed content streams) covering the four outcome
 * states: text layer, no-text-layer (scan), over-budget, low-quality — plus
 * TJ arrays, hex strings, escapes, and the ToUnicode best-effort map.
 *
 * @module provider-proxy/__tests__/anthropicPdfText.test
 */

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { extractPdfText } from '../ingress/anthropicPdfText';

function pdfWithContentStream(content: string, compress = true): string {
  const bytes = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const head = Buffer.from('%PDF-1.4\n1 0 obj << /Length ' + bytes.length + ' >>\nstream\n', 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n', 'latin1');
  return Buffer.concat([head, bytes, tail]).toString('base64');
}

describe('extractPdfText', () => {
  it('extracts Tj literal-string text from a compressed content stream', () => {
    const pdf = pdfWithContentStream('BT /F1 12 Tf (Hello PDF text) Tj ET');
    const result = extractPdfText(pdf);
    expect(result).toEqual({ text: 'Hello PDF text' });
  });

  it('extracts TJ array segments and joins line moves', () => {
    const pdf = pdfWithContentStream(
      'BT [(H)-3(e)-4(llo)] TJ T* (second line) Tj ET',
    );
    const result = extractPdfText(pdf);
    expect('text' in result && result.text).toContain('Hello');
    expect('text' in result && result.text).toContain('second line');
  });

  it('handles escapes, nested parens, and hex strings', () => {
    const pdf = pdfWithContentStream(
      'BT (line\\nbreak \\(paren\\)) Tj <48656C6C6F> Tj ET',
    );
    const result = extractPdfText(pdf);
    expect('text' in result && result.text).toContain('line\nbreak (paren)');
    expect('text' in result && result.text).toContain('Hello');
  });

  it('a scan (no text operators) reports no-text-layer', () => {
    const pdf = pdfWithContentStream('/Image Do q Q');
    expect(extractPdfText(pdf)).toEqual({ reason: 'no-text-layer' });
  });

  it('garbage bytes (no streams / not a PDF) report no-text-layer without throwing', () => {
    expect(extractPdfText(Buffer.from('not a pdf at all').toString('base64'))).toEqual({
      reason: 'no-text-layer',
    });
    expect(extractPdfText('!!!invalid-base64!!!')).toEqual({ reason: 'no-text-layer' });
    expect(extractPdfText('')).toEqual({ reason: 'no-text-layer' });
  });

  it('an encrypted PDF reports no-text-layer', () => {
    const pdf = pdfWithContentStream('BT (secret) Tj ET');
    const withEncrypt = Buffer.concat([
      Buffer.from('%PDF-1.4\n/Encrypt 3 0 R\n', 'latin1'),
      Buffer.from(pdf, 'base64'),
    ]).toString('base64');
    expect(extractPdfText(withEncrypt)).toEqual({ reason: 'no-text-layer' });
  });

  it('a pathological input over the budget reports over-budget (never unbounded work)', () => {
    // A large compressed stream + a tiny budget (1ms ⇒ ~50KB allowance).
    const bigContent = 'BT (' + 'x'.repeat(200_000) + ') Tj ET';
    const pdf = pdfWithContentStream(bigContent);
    expect(extractPdfText(pdf, 1)).toEqual({ reason: 'over-budget' });
    // The SAME pdf under the default budget extracts fine.
    const ok = extractPdfText(pdf);
    expect('text' in ok).toBe(true);
  });

  it('unprintable extraction fails the quality gate as low-quality', () => {
    const garbage = String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8);
    const pdf = pdfWithContentStream(`BT (${garbage}) Tj ET`);
    expect(extractPdfText(pdf)).toEqual({ reason: 'low-quality' });
  });

  it('a compression BOMB is bounded at inflate time (maxOutputLength), not after materialization', () => {
    // 10MB of a repeated byte compresses to a few KB — the pre-fix code fully
    // inflated it before the byte accounting ran. A 1ms budget (⇒ ~50KB cap)
    // must reject it as over-budget WITHOUT the multi-MB spike.
    const bomb = pdfWithContentStream(`BT (${'x'.repeat(10_000_000)}) Tj ET`);
    expect(bomb.length).toBeLessThan(100_000); // fixture sanity: tiny compressed, huge decompressed
    expect(extractPdfText(bomb, 1)).toEqual({ reason: 'over-budget' });
  });

  it('a bfrange-heavy CMap exceeding the entry cap fails toward over-budget (bounded derived work)', () => {
    // Two LEGAL-size ranges (65536 + 6 entries) that together exceed the
    // 65_536-entry cap — each range passes the width guard; only the total
    // cap bounds the derived work.
    const cmap = deflateSync(
      Buffer.from(
        'beginbfrange\n<0000> <ffff> <0041>\n<10000> <10005> <0041>\nendbfrange',
        'latin1',
      ),
    );
    const content = deflateSync(Buffer.from('BT (ABC) Tj ET', 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('2 0 obj stream\n', 'latin1'),
      cmap,
      Buffer.from('\nendstream 1 0 obj stream\n', 'latin1'),
      content,
      Buffer.from('\nendstream\n', 'latin1'),
    ]).toString('base64');
    expect(extractPdfText(pdf)).toEqual({ reason: 'over-budget' });
  });

  it('a LEGIT small bfrange still maps', () => {
    const cmap = deflateSync(
      Buffer.from('beginbfrange\n<0041> <0041> <005A>\nendbfrange', 'latin1'),
    );
    const content = deflateSync(Buffer.from('BT (ABC) Tj ET', 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('2 0 obj stream\n', 'latin1'),
      cmap,
      Buffer.from('\nendstream 1 0 obj stream\n', 'latin1'),
      content,
      Buffer.from('\nendstream\n', 'latin1'),
    ]).toString('base64');
    expect(extractPdfText(pdf)).toEqual({ text: 'ZBC' });
  });

  it('ToUnicode bfchar maps extracted codes best-effort', () => {
    // Content shows codes A/B/C; a CMap stream maps 0041 → 'Z' (B/C unmapped).
    const cmap = deflateSync(
      Buffer.from('/CIDInit /ProcSet 2 0 R\nbeginbfchar\n<0041> <005A>\nendbfchar', 'latin1'),
    );
    const content = deflateSync(Buffer.from('BT (ABC) Tj ET', 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n', 'latin1'),
      Buffer.from('2 0 obj stream\n', 'latin1'),
      cmap,
      Buffer.from('\nendstream 1 0 obj stream\n', 'latin1'),
      content,
      Buffer.from('\nendstream\n', 'latin1'),
    ]).toString('base64');
    const result = extractPdfText(pdf);
    expect(result).toEqual({ text: 'ZBC' });
  });
});
