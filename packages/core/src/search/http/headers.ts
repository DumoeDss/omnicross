/**
 * The browser navigation header profile the search transport sends.
 *
 * This is the profile `packages/core/test-fixtures/http-search/` was captured
 * with, so changing it invalidates the fixtures as live-behavior evidence.
 *
 * Ported from Elftia's `webFetchHttp.browserHeaders()` with ONE deliberate
 * difference: the Chrome version is PINNED here instead of read from
 * `process.versions.chrome`. Elftia runs inside Electron and inherits a real
 * Chromium version; `@omnicross/core` runs in plain Node, where that field is
 * absent — pinning keeps the sent profile identical across every host and
 * matches the spec's "pinned Chrome desktop User-Agent".
 *
 * @module search/http/headers
 */

/** The Chrome build the committed fixtures were captured with. */
const CHROME_VERSION = '144.0.0.0';
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

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
