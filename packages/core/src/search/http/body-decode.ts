/**
 * Decode a fetched search page with the charset the server actually used.
 *
 * Ported from Elftia's `httpBodyDecode.ts` — part of `fetchWebResource`'s
 * semantics, not an addition. A bare UTF-8 decode turns a GB2312/GBK page (the
 * default on plenty of Chinese sites, and Bing geo-redirects to `cn.bing.com`
 * from many networks) into a wall of U+FFFD, which then parses as a structurally
 * valid SERP with unusable text.
 *
 * Precedence follows the HTML standard minus the parts needing a full parser:
 * `Content-Type` header → `<meta>` in the prolog → UTF-8 → windows-1252.
 *
 * @module search/http/body-decode
 */

/** Only the head of a document can declare its charset. */
const META_SNIFF_BYTES = 4096;

const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'x-unicode20utf8']);

/** `text/html; charset=gb2312` → `gb2312`. */
export function charsetFromContentType(contentType: string): string | null {
  const match = /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Read a `<meta charset>` declaration out of the prolog. The prolog is
 * ASCII-compatible in every encoding this matters for, so latin1 is safe.
 */
export function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, META_SNIFF_BYTES)).toString('latin1');
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i.exec(head);
  return metaCharset ? metaCharset[1].toLowerCase() : null;
}

/** Decode a response body to text. */
export function decodeSearchBody(bytes: Uint8Array, contentType = ''): string {
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(bytes);

  if (declared && !UTF8_LABELS.has(declared)) {
    const decoder = decoderFor(declared);
    if (decoder) return decoder.decode(bytes);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Undeclared and not UTF-8 — the standard's fallback for an unlabeled
    // document. Lossless for single-byte Latin pages, and never throws.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null; // label unknown to the runtime — fall through to UTF-8
  }
}
