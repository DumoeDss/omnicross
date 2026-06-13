/**
 * builtin-web-fetch — Lightweight URL content fetcher for BuiltinToolExecutor.
 *
 * Readability + Turndown extraction, without any LLM summarization
 * dependency.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 5;

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent': CHROME_UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

/**
 * Fetch a URL and extract its main content as Markdown.
 * Returns extracted text truncated to `maxChars`.
 */
export async function fetchAndExtractUrl(url: string, maxChars: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetchWithRedirectLimit(url, controller.signal);
    clearTimeout(timer);

    const contentType = res.headers.get('content-type') ?? '';
    const rawText = await readBodyWithLimit(res);

    let text: string;
    if (contentType.includes('json')) {
      try { text = JSON.stringify(JSON.parse(rawText), null, 2); }
      catch { text = rawText; }
    } else if (contentType.includes('html')) {
      text = extractHtml(rawText, (res as any).url || url);
    } else {
      text = rawText;
    }

    return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[Content truncated]' : text;
  } finally {
    clearTimeout(timer);
  }
}

function extractHtml(html: string, url: string): string {
  const dom = new JSDOM(html, { url });

  // Remove noise elements before Readability
  const doc = dom.window.document;
  for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'iframe']) {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  }

  const reader = new Readability(doc);
  const article = reader.parse();

  if (article?.content) {
    return turndown.turndown(article.content).replace(/\n{3,}/g, '\n\n');
  }

  // Fallback: body text
  const body = doc.body?.textContent || '';
  return body.replace(/\s+/g, ' ').trim();
}

async function fetchWithRedirectLimit(url: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = url;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(currentUrl, { signal, redirect: 'manual', headers: FETCH_HEADERS });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }
    Object.defineProperty(res, 'url', { value: currentUrl, writable: false });
    return res;
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

async function readBodyWithLimit(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes > MAX_RESPONSE_BYTES ? MAX_RESPONSE_BYTES : totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    const len = Math.min(chunk.byteLength, combined.byteLength - offset);
    combined.set(chunk.subarray(0, len), offset);
    offset += len;
    if (offset >= combined.byteLength) break;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}
