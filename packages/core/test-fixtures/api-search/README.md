# API search fixtures (Tavily / Jina / SearXNG / Zhipu)

Offline response-shape evidence for the keyed API search providers `tavily`, `jina`,
`searxng`, `zhipu` and `z.ai`, plus the Jina reader. Written for Phase 1 阶段4 of the
search-runtime extraction (`docs/design/omnicross-search-runtime-extraction-plan.md`);
`packages/core/src/search/api/__tests__/` is the consumer.

**These files are test data, not build input.** They live outside `src/`, so no `tsup`
entry registration applies and nothing here enters the published package surface.

The wire contracts these fixtures encode come from the Elftia reference adapters, whose
working-tree sha256 hashes were re-verified byte-identical against the 阶段0 manifest
(`docs/design/search-baseline/elftia-search-baseline.md` §2) immediately before porting,
at Elftia HEAD `6c6a03900`:

| Reference file (under `packages/desktop/app/main/services/capabilities/search/`) | sha256 |
| --- | --- |
| `providers/TavilyProvider.ts` | `3134dcd74f4d3c2023abf54792c3b36587b2024f5d0018eccbd1c53836a195a6` |
| `providers/JinaProvider.ts` | `374d2252e22ab4249b3b969ce882e1e8e6f5c1b6deb456b9d3f1ab89b22eee15` |
| `providers/JinaReader.ts` | `85d8b2a671c20dd214ae961316c661be11a946808a3083976cf059e31aae908d` |
| `providers/SearxngProvider.ts` | `c1ec6694715e264d6a170b3d280b8388f987cb85737bee84915c86a7e6279374` |
| `providers/ZhipuProvider.ts` | `2a9a0f5b6d65d1d55bf55f4c6324d5491544427f8eaafc4d3889a1b1366118e5` |
| `ApiKeyRotator.ts` | `9c649cba995ff6201628c8ffd2eb183b4579a1267a009fb536fa64d2ed067a6c` |
| `searchSecretRefs.ts` | `d7c1d8a6431db6e1a07ecbf36a320d24dde01a0c0b9c834a6dc018dd0ad87861` |

---

## Provenance

Every file is labeled `captured` (a real HTTP response, trimmed and sanitized) or
`synthetic` (hand-built from the response shape the pinned adapter reads).
**A `synthetic` file is never capture evidence.**

**Every file here is `synthetic`, and the whole set is, on purpose.** Three of the four
APIs answer only an authenticated request, so a capture would require a real account key
and would embed account-correlated data (request ids, quota state, personalized result
ordering) in the repository. The regression weight therefore sits in the
failure-injection matrices in `providers.test.ts` and `transport.test.ts`, which drive
every status, shape and cancellation path through a mocked transport; these files pin the
happy-path **field mapping** — which is what the port could get wrong — and nothing more.

A file MAY be relabeled `captured` later if a capture is obtainable **without secrets**
(keyless Jina, or a public SearXNG instance), with the usual provenance row. That has not
been done here, and relabeling without a real capture would make this table a lie.

The one query any fixture references is `mozilla developer network http headers` — the
same public, low-sensitivity query the http-search fixtures were captured with and the
one `doctor search --live` sends. No fixture contains a real user query.

### `tavily/` — `synthetic`

| File | Pins |
| --- | --- |
| `tavily-search-success.synthetic.json` | `results[]` with `{title, url, content, score}`; the adapter maps the first three and ignores `score`. Three rows, so "no client-side slice" is observable against a caller asking for two. |
| `tavily-search-empty.synthetic.json` | A present-but-empty `results` array — an authoritative "found nothing", which is a SUCCESS, not a failure. |
| `tavily-error-echoes-request.synthetic.json` | The failure mode the whole redaction layer exists for: a 4xx quoting the request back, with the API key inside a **serialized JSON string** (`\"api_key\":\"…\"`). |

`tavily-error-echoes-request.synthetic.json` carries the literal placeholder `__API_KEY__`
where a key would sit. The leak-gate test substitutes its own planted canary at runtime, so
the committed file never holds a credential-shaped value — asserted by a test as well as by
the scan below.

### `jina/` — `synthetic`

| File | Pins |
| --- | --- |
| `jina-search-success.synthetic.json` | The `content \|\| description` fallback in all three of its states: content present, content absent, content present but empty. |
| `jina-search-empty.synthetic.json` | Empty `data` array. |
| `jina-error-unauthorized.synthetic.json` | A 401 body quoting an `Authorization` header (placeholder `__API_KEY__`), mapping to `auth_failed`. |
| `jina-reader-success.synthetic.json` | The reader's `data.title` / `data.content` shape, with the top-level fallback exercised inline in the test rather than by a second file. |

### `searxng/` — `synthetic`

| File | Pins |
| --- | --- |
| `searxng-search-success.synthetic.json` | `results[]` including a row with **no** `content` key at all, which must map to `''` rather than `undefined`. |
| `searxng-search-empty.synthetic.json` | Empty `results` array. |
| `searxng-error-forbidden.synthetic.json` | A 403 from an instance with JSON output disabled or Basic auth rejected. Placeholder `__BASIC_CREDENTIALS__`. |

### `zhipu/` — `synthetic`

Covers `z.ai` too: one class, one wire contract, two ids and two default hosts.

| File | Pins |
| --- | --- |
| `zhipu-search-success.synthetic.json` | `search_result[]` whose URL field is **`link`**, not `url` — the mapping quirk most likely to be "fixed" by mistake. |
| `zhipu-search-empty.synthetic.json` | Empty `search_result` array. |
| `zhipu-error-rate-limited.synthetic.json` | The 429 body shape, mapping to `rate_limited`. |

---

## Sanitization

No fixture contains an API key, an `Authorization` header value, Basic-auth material, a
cookie, a session identifier, an email address, a local filesystem path, or a real user
query. Result URLs point at public documentation (`developer.mozilla.org`,
`rfc-editor.org`, `en.wikipedia.org`); request ids are zero-filled.

The scan is `rasen/changes/search-phase1-api-providers/evidence/fixture-scan.py`
(ephemeral tooling, not part of the package build): **19 credential/PII patterns over
13 files, 0 matches**, every file valid JSON, every `query` field equal to the one
disclosed query. The patterns were verified non-vacuous by planting a file containing a
Bearer token, a Basic blob and two API-key shapes — the scan reported 6 matches and exited
1; the planted file was then removed.

Two patterns are deliberately narrower than the obvious version:

- the `Bearer`/`Basic` patterns exempt `__`-prefixed placeholders, since those exist
  precisely so no credential-shaped value is committed;
- the `Basic` pattern requires a base64 SHAPE, not just length — `[A-Za-z0-9+/=]{8,}`
  matches the English phrase "Basic authentication", which is a false alarm that would
  train a future reader to ignore the scan.
