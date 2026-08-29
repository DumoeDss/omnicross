/**
 * anthropicPdfText — the zero-dependency PDF text-layer extractor behind the
 * translate-path `document` block handling (`claude-api-transform-fidelity`,
 * R7 / design D4).
 *
 * Scope (deliberate): find `stream…endstream` sections, inflate the
 * FlateDecode ones, and pull the TEXT SHOWING operators' strings (Tj / TJ /
 * ' / ") out of content streams, applying a best-effort ToUnicode CMap when
 * one is parseable. No object graph, no xref, no rendering — a scan (image-only)
 * PDF has no text operators and is reported as `no-text-layer`, rasterization
 * is OUT (needs a real renderer; rejected as renderer-dependent).
 *
 * Guarantees:
 *  - NEVER throws on malformed input (any structural surprise → `no-text-layer`);
 *  - bounded synchronous work: a deterministic decompressed-byte budget
 *    (`BUDGET_BYTES_PER_MS × budgetMs`) keeps the worst case far below the
 *    configured wall-clock budget — exceeding it reports `over-budget`;
 *  - a QUALITY GATE (printable-character ratio + minimum text) rejects garbage
 *    extraction as `low-quality` — garbage text in a prompt is worse than an
 *    explicit failure.
 *
 * @module provider-proxy/ingress/anthropicPdfText
 */

import { inflateSync } from 'node:zlib';

/** Deterministic decompressed-bytes allowance per budget millisecond. */
const BUDGET_BYTES_PER_MS = 50_000;

/** Default wall-clock budget when the caller passes none (§10 config default). */
export const DEFAULT_PDF_TEXT_BUDGET_MS = 2000;

/** Printable-ratio floor for the quality gate. */
const MIN_PRINTABLE_RATIO = 0.55;
/** Minimum extracted length for the quality gate. */
const MIN_TEXT_LENGTH = 3;
/**
 * Hard cap on TOTAL ToUnicode map entries across all CMap streams (review
 * C-M2): bfrange expansion is DERIVED work — a tiny CMap can declare a range
 * of millions of codes — so the map itself is capped; exceeding the cap fails
 * the extraction toward the explicit over-budget 400 path (a legit CMap tops
 * out at one entry per Unicode code point).
 */
const MAX_CMAP_ENTRIES = 65_536;

export type PdfTextExtraction =
  | { text: string }
  | { reason: 'no-text-layer' | 'over-budget' | 'low-quality' };

/** Extract the text layer of a base64-encoded PDF. Never throws. */
export function extractPdfText(
  base64: string,
  budgetMs: number = DEFAULT_PDF_TEXT_BUDGET_MS,
): PdfTextExtraction {
  try {
    return extract(Buffer.from(base64, 'base64'), budgetMs);
  } catch {
    return { reason: 'no-text-layer' };
  }
}

function extract(pdf: Buffer, budgetMs: number): PdfTextExtraction {
  const latin = pdf.toString('latin1');
  if (!latin.startsWith('%PDF-') && !latin.includes('%PDF-')) return { reason: 'no-text-layer' };
  if (latin.includes('/Encrypt')) return { reason: 'no-text-layer' };

  const budget = Math.max(
    1,
    Math.floor((Number.isFinite(budgetMs) ? budgetMs : DEFAULT_PDF_TEXT_BUDGET_MS) * BUDGET_BYTES_PER_MS),
  );

  // ── Inflate every stream once (best-effort), under budget. The budget
  // counts DECOMPRESSED bytes (the real work — a tiny compressed bomb expands
  // here) plus the raw size of any stream left uncompressed. ────────────────
  const inflated: Buffer[] = [];
  let consumed = 0;
  let overBudget = false;
  let index = latin.indexOf('stream');
  while (index !== -1) {
    const start =
      latin[index + 'stream'.length] === '\r' && latin[index + 'stream'.length + 1] === '\n'
        ? index + 'stream'.length + 2
        : latin[index + 'stream'.length] === '\n'
          ? index + 'stream'.length + 1
          : index + 'stream'.length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    const raw = pdf.subarray(start, end);
    let out: Buffer | null = null;
    if (raw.length > 0) {
      try {
        // C-M1: bound the inflate ITSELF — without `maxOutputLength` a tiny
        // compressed bomb fully materializes (multi-GB spike) before the byte
        // accounting below ever runs. The per-stream cap is the remaining
        // total budget; zlib throws when the output would exceed it.
        out = inflateSync(raw, { maxOutputLength: Math.max(1, budget - consumed) });
      } catch (err) {
        if (err instanceof RangeError) {
          // Decompressed output exceeded the cap — the bomb case, bounded.
          overBudget = true;
          break;
        }
        out = null; // Uncompressed or unknown filter — the text ops may still be raw.
      }
    }
    const stream = out ?? raw;
    consumed += stream.length;
    if (consumed > budget) {
      overBudget = true;
      break;
    }
    inflated.push(stream);
    index = latin.indexOf('stream', end + 'endstream'.length);
  }

  if (overBudget) return { reason: 'over-budget' };
  if (inflated.length === 0) return { reason: 'no-text-layer' };

  // ── Best-effort ToUnicode: any stream containing bfchar/bfrange maps codes. ──
  const cmap = parseToUnicode(inflated);
  if (cmap === null) return { reason: 'over-budget' }; // CMap expansion cap (C-M2)

  // ── Pull text-showing strings out of content-looking streams. ────────────
  let text = '';
  for (const stream of inflated) {
    if (text.length > budget) break; // output side of the same work cap
    const asLatin = stream.toString('latin1');
    if (asLatin.includes('beginbfchar') || asLatin.includes('beginbfrange')) continue; // CMap, not content
    if (!/(Tj|TJ)\b/.test(asLatin)) continue; // no text-showing operators at all
    text += extractContentStreamText(asLatin, cmap);
  }

  if (text.length === 0) return { reason: 'no-text-layer' };

  const printable = countPrintable(text);
  const ratio = printable / text.length;
  if (text.trim().length < MIN_TEXT_LENGTH || ratio < MIN_PRINTABLE_RATIO) {
    return { reason: 'low-quality' };
  }
  return { text: text.trim() };
}

// ── Content-stream tokenizer (strings + text-showing operators) ──────────────

/** Parse one literal `(…)` string starting at `i` (must be the `(`); returns [value, nextIndex]. */
function parseLiteralString(s: string, i: number): [string, number] {
  let out = '';
  let depth = 1;
  i += 1;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) break;
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next >= '0' && next <= '7') {
        // Octal escape: up to 3 digits.
        let digits = '';
        let j = i + 1;
        while (digits.length < 3 && j < s.length && s[j] >= '0' && s[j] <= '7') {
          digits += s[j];
          j += 1;
        }
        out += String.fromCharCode(Number.parseInt(digits, 8));
        i = j - 1;
      } else {
        out += next; // \( \) \\ and any other escaped char.
      }
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    out += ch;
    i += 1;
  }
  return [out, i + 1];
}

/** Parse one hex `<…>` string starting at `i` (must be the `<`). */
function parseHexString(s: string, i: number): [string, number] {
  const end = s.indexOf('>', i);
  if (end === -1) return ['', s.length];
  const hex = s.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = '';
  for (let k = 0; k < padded.length; k += 2) {
    out += String.fromCharCode(Number.parseInt(padded.slice(k, k + 2), 16));
  }
  return [out, end + 1];
}

/** Collect the strings a content stream SHOWS (Tj / TJ arrays / ' / ") in order. */
function extractContentStreamText(s: string, cmap: Map<string, string>): string {
  let out = '';
  let i = 0;
  // The most recent standalone string / array-of-strings operand.
  let lastString = '';
  let lastArray: string[] | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '(') {
      const [value, next] = parseLiteralString(s, i);
      lastString = value;
      lastArray = null;
      i = next;
      continue;
    }
    if (ch === '<' && s[i + 1] !== '<') {
      const [value, next] = parseHexString(s, i);
      lastString = value;
      lastArray = null;
      i = next;
      continue;
    }
    if (ch === '[') {
      // TJ array: collect the string segments between here and the closing ].
      const segments: string[] = [];
      let j = i + 1;
      while (j < s.length && s[j] !== ']') {
        if (s[j] === '(') {
          const [value, next] = parseLiteralString(s, j);
          segments.push(value);
          j = next;
        } else if (s[j] === '<' && s[j + 1] !== '<') {
          const [value, next] = parseHexString(s, j);
          segments.push(value);
          j = next;
        } else {
          j += 1;
        }
      }
      lastArray = segments;
      lastString = '';
      i = j + 1;
      continue;
    }
    if (/[A-Za-z'"*]/.test(ch)) {
      // Operator (or the start of one): read the word.
      let j = i;
      while (j < s.length && /[A-Za-z0-9'"*]/.test(s[j])) j += 1;
      const op = s.slice(i, j);
      if (op === 'Tj') {
        out += applyCmap(lastString, cmap);
      } else if (op === 'TJ' && lastArray) {
        for (const segment of lastArray) out += applyCmap(segment, cmap);
      } else if (op === "'" || op === '"') {
        out += '\n' + applyCmap(lastString, cmap);
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET') {
        // Line/position moves read as line breaks so extracted text isn't glued.
        if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

// ── ToUnicode best-effort ─────────────────────────────────────────────────────

/**
 * Parse `beginbfchar`/`beginbfrange` pairs out of any CMap-like stream.
 * Returns `null` when the TOTAL derived-entry count would exceed
 * {@link MAX_CMAP_ENTRIES} — the caller fails toward the explicit over-budget
 * path rather than doing unbounded derived work (review C-M2).
 */
function parseToUnicode(streams: Buffer[]): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const stream of streams) {
    const text = stream.toString('latin1');
    if (!text.includes('beginbfchar') && !text.includes('beginbfrange')) continue;
    // bfchar: <srcCode> <dstString>
    for (const m of text.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      if (map.size >= MAX_CMAP_ENTRIES) return null;
      map.set(m[1].toLowerCase(), hexToUnicode(m[2]));
    }
    // bfrange: <lo> <hi> <dstStart> (a contiguous dst block, best-effort)
    for (const m of text.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = Number.parseInt(m[1], 16);
      const hi = Number.parseInt(m[2], 16);
      const dst = Number.parseInt(m[3], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 65_535) continue;
      for (let c = lo; c <= hi; c += 1) {
        if (map.size >= MAX_CMAP_ENTRIES) return null;
        map.set(c.toString(16).padStart(m[1].length, '0'), String.fromCharCode(dst + (c - lo)));
      }
    }
  }
  return map;
}

function hexToUnicode(hex: string): string {
  // UTF-16BE hex string (standard CMap dst form).
  const padded = hex.length % 4 === 0 ? hex : hex.padEnd(Math.ceil(hex.length / 4) * 4, '0');
  let out = '';
  for (let k = 0; k < padded.length; k += 4) {
    out += String.fromCharCode(Number.parseInt(padded.slice(k, k + 4), 16));
  }
  return out;
}

/** Map one raw extracted string through the CMap when its byte codes have entries. */
function applyCmap(value: string, cmap: Map<string, string>): string {
  if (cmap.size === 0 || value.length === 0) return value;
  let out = '';
  let mapped = 0;
  for (let k = 0; k < value.length; k += 1) {
    const code = value.charCodeAt(k).toString(16).padStart(2, '0');
    const hit = cmap.get(code) ?? cmap.get(code.padStart(4, '0'));
    if (hit !== undefined) {
      out += hit;
      mapped += 1;
    } else {
      out += value[k];
    }
  }
  return mapped > 0 ? out : value;
}

function countPrintable(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) count += 1;
  }
  return count;
}
