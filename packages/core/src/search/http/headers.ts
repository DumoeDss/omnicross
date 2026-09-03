/**
 * The browser navigation header profile the search transport sends.
 *
 * This is the profile `packages/core/test-fixtures/http-search/` was captured
 * with, so changing it invalidates the fixtures as live-behavior evidence.
 *
 * Ported verbatim from Elftia's `webFetchHttp.browserHeaders()` — a verified
 * config; do not deviate from it. The Chromium version is read from the
 * RUNTIME, exactly as Elftia does: `process.versions.chrome` inside an
 * Electron host (a real, complete build number), and Elftia's own fixed
 * fallback when no Chromium runtime reports one (plain Node). Never pin or
 * invent a version string here — a fabricated build number is a bot
 * fingerprint no real browser ever sends.
 *
 * @module search/http/headers
 */

/**
 * The Chromium build of the running host, read once (process.versions is
 * immutable): the Electron host's real version, else Elftia's fixed fallback.
 */
const CHROME_VERSION = process.versions.chrome ?? '144.0.0.0';
const CHROME_MAJOR = CHROME_VERSION.split('.')[0] || '144';

/** The exact header set sent with every search request. */
export const SEARCH_BROWSER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-CH-UA': `"Chromium";v="${CHROME_MAJOR}", "Not=A?Brand";v="24"`,
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
});

/**
 * A fresh mutable copy of the profile.
 *
 * `Accept-Encoding` is deliberately absent: undici sets and negotiates it, and
 * decompresses the response itself. Declaring it by hand would mean owning the
 * decode too.
 */
export function searchBrowserHeaders(): Record<string, string> {
  return { ...SEARCH_BROWSER_HEADERS };
}
