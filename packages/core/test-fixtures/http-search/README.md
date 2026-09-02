# HTTP search fixtures (Bing / DuckDuckGo)

Offline regression evidence for the keyless HTTP search providers `http-bing` and
`http-duckduckgo`. Captured for Phase 1 阶段0 of the search-runtime extraction
(`docs/design/omnicross-search-runtime-extraction-plan.md`); the HTTP-slice change (阶段2)
is the intended consumer.

**These files are test data, not build input.** They live outside `src/`, so no `tsup`
entry registration applies and nothing here enters the published package surface.

The parser behavior these fixtures target is the Elftia reference implementation
`packages/agent-engine/src/engine/tinyelf/tools/webFetchSearch.ts` at working-tree sha256
`2fa0275e2430cc87c2dfb7702ad3c62f2e7b71734dfa94475865856e5f5ab057` (see
`docs/design/search-baseline/elftia-search-baseline.md` §2). Elftia itself ships **no**
captured fixtures — `WebTools.test.ts` uses inline synthetic HTML only — so everything here
is new capture work.

---

## Provenance

Every file is labeled `captured` (a real HTTP response, trimmed and sanitized) or
`synthetic` (hand-built from the parser selectors). **A `synthetic` file is never capture
evidence.** All captures were taken on **2026-09-01** with `curl -sSL`, a Chrome 144
desktop `User-Agent`, and `Accept-Language: en-US,en;q=0.9` — the header profile
`webFetchHttp.browserHeaders()` sends.

### `bing/bing-serp-normal.html` — `captured`

| | |
| --- | --- |
| Requested | `https://www.bing.com/search?q=mozilla+developer+network+http+headers` |
| Final URL | `https://cn.bing.com/search?q=mozilla+developer+network+http+headers` (1 redirect) |
| Status | 200, 98 648 bytes raw → 10 913 bytes trimmed |
| Fixed query | `mozilla developer network http headers` |
| Contains | 10 × `li.b_algo`, each with an `h2 a[href]` direct result link and a `.b_caption p` snippet |

Bing geo-redirects to `cn.bing.com` from the capture environment, so result titles are
Chinese-locale. The parsers are language-agnostic (`li.b_algo` / `h2 a` / `.b_caption p`),
and the fixture was chosen so `searchPageTrustError` **passes** on it — this is the
happy-path fixture for both `parseBingResults` and `bingTrustError`.

### `bing/bing-serp-untrusted-decoy.html` — `captured`

| | |
| --- | --- |
| Requested | `https://www.bing.com/search?q=hypertext+transfer+protocol&setmkt=en-US&setlang=en-US&ensearch=1` |
| Final URL | `https://cn.bing.com/search?...` (1 redirect) |
| Status | 200, 109 814 bytes raw → 11 792 bytes trimmed |
| Fixed query | `hypertext transfer protocol` |
| Contains | 10 × `li.b_algo` whose titles are wholly unrelated to the query (CCTV live-TV pages), plus 20 real `/ck/a?…u=a1<base64url>` hrefs — **10 on the `h2 a` result-title anchors and 10 on the `.tilk` attribution anchors** |

Bing served this page for the query above; the topic mismatch was not induced by us and its
cause is unknown. It reproduces the `bingTrustError` **zero-query-term-hit refusal** path
exactly (`Bing returned an untrusted search result page with zero query-term hits in result
titles; …`), which makes it the anti-decoy fixture. It is also the only **live** evidence of
the `/ck/a?…u=a1<base64url>` href form on result-title anchors: running `parseBingResults`
over it unwraps all ten to their real `https://tv.cctv.com/…` targets. That unwrap only ever
happens after the trust check, which this page fails — hence the separate synthetic fixture
below for the trust-passing unwrap path.

### `bing/bing-serp-ck-redirect.synthetic.html` — `synthetic`

**Not a capture.** `/ck/a` result-title links *were* captured live — but only on
`bing-serp-untrusted-decoy.html`, a page that fails `bingTrustError`, so
`searchWebViaFetch` refuses it before any unwrapped result is returned. No **trust-passing**
capture with `/ck/a` result links was obtained here: every trust-passing Bing response in
this environment carried direct URLs on its `h2 a` anchors. Rather than relabel the decoy or
fabricate a capture, the happy-path unwrap variant is a labeled synthetic file.

Structure derived from `bingResultLinks` / `parseBingResults` / `cleanBingUrl` in
`webFetchSearch.ts`, with the `/ck/a?…u=a1<base64url>` href shape copied from the real
markup in `bing-serp-untrusted-decoy.html`. Five `li.b_algo` entries covering:

1. `u=a1…` decoding to `https://en.wikipedia.org/wiki/HTTP` (unwrap succeeds);
2. `u=a1…` decoding to `https://developer.mozilla.org/en-US/docs/Web/HTTP` (unwrap succeeds);
3. a direct `https://www.rfc-editor.org/…` href (no unwrap needed);
4. `u=b2…` — no `a1` prefix, so `cleanBingUrl` falls back to the absolute `/ck/a` href;
5. `u=a1…` decoding to `/relative/path/only` — not `http(s)`, so the same fallback applies.

Targets are public documentation URLs; no capture-environment data is present.

### `bing/bing-serp-empty.synthetic.html` — `synthetic`

**Not a capture.** Added by the HTTP-slice change (阶段2) for the plan-mandated
three-way outcome distinction: a *recognized* SERP with zero organic results must return
`[]`, not the error an unrecognizable page produces. No such capture exists — every query
tried against Bing returned results, and inducing a genuinely empty SERP means firing
nonsense queries at a live engine until one lands, which is neither reliable nor polite.

Structure is derived from the recognition marker the parser uses (`isBingSerp` → the
`#b_results` container) exactly as it appears in the captured `bing-serp-normal.html`, with
zero `li.b_algo` entries and a `.b_no` notice. It deliberately contains **no `h2 a[href]`
anywhere**, because `bingResultLinks` falls back to a document-wide `h2 a[href]` query when
no scoped result links exist — a stray heading link would make the page parse as a result
instead of as empty. Fixed query: `zzqxwv nonexistent query string` (an invented
non-word, not user-derived).

### `duckduckgo/ddg-html-serp-empty.synthetic.html` — `synthetic`

**Not a capture.** The DuckDuckGo half of the same three-way distinction, for the same
reason. Structure derived from `isDuckDuckGoSerp`'s marker (the `#links` / `.results`
container) as it appears in the captured `ddg-html-serp.html`, with zero `.result`
containers. It contains no element carrying `result`, `result--web` or `web-result` and no
`a.result-link`: any of those would make the page parse as a result set (or as the lite
layout) rather than as empty, so the notice uses `no-results`. Same fixed query as above.

### `duckduckgo/ddg-html-serp.html` — `captured`

| | |
| --- | --- |
| Requested / final | `https://html.duckduckgo.com/html/?q=hypertext%20transfer%20protocol` |
| Status | 200, 46 565 bytes raw → 14 460 bytes trimmed |
| Fixed query | `hypertext transfer protocol` |
| Contains | 10 × `.result` containers with `a.result__a` links carrying `//duckduckgo.com/l/?uddg=<encoded>` redirects and `.result__snippet` snippets (40 `uddg` parameters retained) |

Happy-path fixture for `parseDuckDuckGoResults` (html layout) and `cleanDuckDuckGoUrl`
`uddg` unwrapping.

### `duckduckgo/ddg-lite-serp.html` — `captured`

| | |
| --- | --- |
| Requested / final | `https://lite.duckduckgo.com/lite/?q=weather%20forecast%20tomorrow` |
| Status | 200, 24 686 bytes raw → 10 318 bytes trimmed |
| Fixed query | `weather forecast tomorrow` |
| Contains | the result `<table>` with 10 × `a.result-link` rows and their following-row `.result-snippet` cells |

**Why a different fixed query.** `lite.duckduckgo.com` started answering HTTP 202 to
`hypertext transfer protocol` after the first few requests and kept doing so across four
attempts spanning several minutes (that is what produced the challenge fixture below). This
capture was taken earlier in the session with the other fixed query and is the only live
lite-layout body obtained. The results are Tokyo weather pages — DuckDuckGo's edge
geolocation, not the capture host's location.

### `duckduckgo/ddg-lite-challenge-202.html` — `captured`

| | |
| --- | --- |
| Requested / final | `https://lite.duckduckgo.com/lite/?q=hypertext%20transfer%20protocol` |
| Status | **202**, 14 177 bytes raw → 471 bytes trimmed |
| Fixed query | `hypertext transfer protocol` |
| Contains | the bot-challenge shell — a `DuckDuckGo` title and header links, zero result rows |

`searchWebViaFetch` special-cases this before parsing:
`if (engine.id === 'duckduckgo' && resource.status === 202) throw new Error('server returned a bot-challenge response (HTTP 202)')`.
The fixture is the body; the 202 status has to be supplied by the test's transport stub.

---

## Coverage against the parser variants

| Variant the parser distinguishes | Fixture | Label |
| --- | --- | --- |
| Bing normal layout (`li.b_algo`, `h2 a`, caption) | `bing/bing-serp-normal.html` | captured |
| Bing `/ck/a?u=a1<base64url>` redirect links on result titles | `bing/bing-serp-ck-redirect.synthetic.html` (trust-passing path) **and** `bing/bing-serp-untrusted-decoy.html` (live, but trust-refused) | **synthetic** + captured — see above |
| Bing anti-decoy refusal (`bingTrustError`) | `bing/bing-serp-untrusted-decoy.html` | captured |
| DDG html layout with `uddg` redirects | `duckduckgo/ddg-html-serp.html` | captured |
| DDG lite layout (`a.result-link` table rows) | `duckduckgo/ddg-lite-serp.html` | captured |
| Anti-bot / challenge response | `duckduckgo/ddg-lite-challenge-202.html` | captured (HTTP 202) |
| Recognized SERP with zero organic results (Bing) | `bing/bing-serp-empty.synthetic.html` | **synthetic** |
| Recognized SERP with zero organic results (DDG html) | `duckduckgo/ddg-html-serp-empty.synthetic.html` | **synthetic** |

Nothing on the target list is MISSING. Every *live-observable* variant has capture evidence;
the three synthetic files exist for outcomes that cannot be captured honestly — the
happy-path `/ck/a` unwrap (the only live `/ck/a` result-link page fails the trust check, so
it cannot double as that fixture) and the two zero-result SERPs (a live engine cannot be
made to return zero results on demand). Each is labeled `synthetic` everywhere — filename,
in-file comment, and this README — rather than presented as capture evidence.

There is deliberately **no** empty *lite*-layout fixture: the html endpoint is the
authoritative one, and the lite layout's empty case adds no distinct parser path.

---

## Trimming applied

Each capture was reduced to parser-relevant structure by an ephemeral script (capture and
trim tooling is change ephemera and is deliberately not committed):

1. Remove `<script>`, `<style>`, `<link>`, `<noscript>`, `<svg>`, `<iframe>`, `<img>`,
   `<meta>`, `<form>`, `<input>`, `<button>`.
2. Keep only the document title plus the result containers — `li.b_algo` for Bing
   (re-wrapped in `<ol id="b_results">`), `.result` for DDG html (re-wrapped in
   `<div id="links" class="results">`), and the single `<table>` holding `a.result-link`
   for DDG lite. DuckDuckGo ad containers (`.result--ad`) and the `.result--more` footer
   were dropped.
3. Delete tracking / impression attributes: `h`, `iid`, `data-id`, `data-bm`,
   `data-rslinkclamp-iid`, `ping`, `style`, `role`, `aria-hidden`, `elementtiming`,
   `tabindex`, `data-testid`, and every `on*` handler.
4. Strip tracking query parameters from every `href`, keeping the parameters the parsers
   actually read (`u` for Bing `/ck/a`, `uddg` for DuckDuckGo): removed `rut`, `fclid`,
   `click_metadata`, `vqd`, `p`, `ptn`, `ver`, `hsh`, `ntb`, `u3`, `bid`, `sc`,
   `ad_domain`, `ad_provider`, `ad_type`.

Trimmed sizes run from 0.5 KB (the challenge body) to 14 KB, against 14–110 KB raw.

---

## Sanitization scan

Run over all eight fixture files before commit (re-run by the HTTP-slice change after the
two synthetic empty-SERP files were added). Every pattern below reported **zero matches**;
the fixtures also contain zero `U+FFFD` replacement characters (encoding-corruption check).

| # | Pattern (regex) | Purpose |
| --- | --- | --- |
| 1 | `\b_U\b` | Bing login cookie name |
| 2 | `\bSID\b\|__Secure-1PSID\|SAPISID` | Google login cookie names |
| 3 | `\bBDUSS\b` | Baidu login cookie name |
| 4 | `(?i)authorization` | auth headers |
| 5 | `(?i)api[_-]?key` | API keys |
| 6 | `search-provider:` | Omnicross/Elftia search secret refs |
| 7 | `(?i)\bbearer\b\|oak_[A-Za-z0-9]` | bearer / gateway tokens |
| 8 | `[?&;]rut=` | DuckDuckGo per-request tracking token |
| 9 | `[?&;]fclid=` | Bing click fingerprint id |
| 10 | `[?&;]vqd=` | DuckDuckGo session token |
| 11 | `click_metadata` | DuckDuckGo ad click payload |
| 12 | `(?i)[?&;](sid\|sessionid\|session_id\|token\|auth\|uid\|cid\|muid)=` | generic session/user params |
| 13 | `h="ID=SERP` | Bing impression token attribute |
| 14 | `\biid=SERP` | Bing instrumentation id attribute |
| 15 | `(?i)set-cookie` | cookie-setting headers |
| 16 | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | email addresses |
| 17 | `(?i)C:\\Users\\\|/Users/[A-Za-z0-9._-]+/` | capture-host user paths |

```
files scanned: 8   total matches: 0
```

**Queries.** Only four fixed, non-user-derived queries appear anywhere in this tree —
`mozilla developer network http headers`, `hypertext transfer protocol`,
`weather forecast tomorrow`, and the invented non-word
`zzqxwv nonexistent query string` used by the two synthetic empty-SERP files. None came
from a user history, log, or audit source. An
earlier `weather forecast tomorrow` capture against Bing was **discarded** rather than
committed because Bing personalised the results with the capture host's approximate
location; the committed Bing fixtures use queries that produce no such content.

## Re-verification

Each fixture was run through `parseBingResults`, `bingTrustError`, `cleanBingUrl`,
`parseDuckDuckGoResults` and `cleanDuckDuckGoUrl` transcribed verbatim from
`webFetchSearch.ts` and executed on the same `jsdom` + `entities` libraries the real parsers
use — not a loose reimplementation. Results:

| Fixture | Result |
| --- | --- |
| `bing/bing-serp-normal.html` | trust check PASS, 10 results parsed |
| `bing/bing-serp-untrusted-decoy.html` | trust check REFUSES (zero query-term hits in titles), 10 results would otherwise parse |
| `bing/bing-serp-ck-redirect.synthetic.html` | trust check PASS, 5 results parsed; `u=a1…` targets unwrapped to their real `https://` URLs and the two fallback branches resolve to the absolute `/ck/a` href |
| `duckduckgo/ddg-html-serp.html` | html layout, 10 results parsed with `uddg` unwrapped |
| `duckduckgo/ddg-lite-serp.html` | lite layout, 10 results parsed |
| `duckduckgo/ddg-lite-challenge-202.html` | 0 results parsed — the failure fixture behaves as one |

The two synthetic empty-SERP files were verified against the 阶段2 parsers instead (they
postdate the transcription check above): each is **recognized** as its engine's SERP and
yields **0 results**, so `search()` returns `[]` rather than throwing — see
`packages/core/src/search/http/__tests__/providers.test.ts`.
