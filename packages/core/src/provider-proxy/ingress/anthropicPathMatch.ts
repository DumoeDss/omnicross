/**
 * anthropicPathMatch — the SINGLE shared classifier for the Anthropic Messages
 * endpoint family (`/v1/messages`, `/v1/messages/count_tokens`, and subpaths).
 *
 * Both serving faces derive their path routing from this one function:
 *  - the outbound API server's `selectEndpoint` (outboundApiRouter.ts), and
 *  - the resident ProviderProxy's `isAnthropicMessagesRequest`
 *    (anthropicMessagesIngress.ts).
 *
 * Before this module existed the two faces each ran a substring
 * `path.includes('/v1/messages')`, which routed EVERY `/v1/messages/*`
 * subresource (e.g. `POST /v1/messages/count_tokens`) into the full generation
 * pipeline — burning real upstream inference on token-counting calls (audit
 * F-1). Sharing one classifier makes "the two faces agree" a construction
 * guarantee instead of a comment convention.
 *
 * Classification ignores the HTTP method on purpose: the error-envelope
 * marking (see `anthropicErrorEnvelope.ts`) marks by the same predicate so even
 * a `GET /v1/messages` gets an Anthropic-shaped 404.
 *
 * @module provider-proxy/ingress/anthropicPathMatch
 */

/** What kind of Anthropic-Messages-family path this is. */
export type AnthropicMessagesPathClass =
  | 'messages'
  | 'count_tokens'
  | 'unsupported-subpath';

/**
 * Classify a request URL against the Anthropic Messages endpoint family.
 *
 * Semantics (query string stripped first, then trailing slashes):
 *  ① path ends with `/v1/messages/count_tokens` → `'count_tokens'`;
 *  ② path ends with `/v1/messages` → `'messages'`;
 *  ③ path matches `…/v1/messages/<non-empty subpath…>` (ending in neither of
 *     the above) → `'unsupported-subpath'`;
 *  ④ everything else (incl. `/v1/messagesfoo`, bare `/messages`,
 *     `/v1beta/...`) → `null`.
 *
 * Order matters: ① before ③ so `/v1/messages/count_tokens` is its own class
 * rather than an unsupported subpath. ② before ③ so an UNFOLDED doubled tail
 * (`/v1/messages/v1/messages` — the resident face has no entry-point folding)
 * still classifies as `'messages'`, matching the pre-change `includes`
 * behavior exactly (zero regression). Path prefixes (`/anthropic/v1/messages`)
 * keep matching via the `endsWith` semantics.
 */
export function classifyAnthropicMessagesPath(
  url: string | undefined,
): AnthropicMessagesPathClass | null {
  if (!url) return null;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  if (path.endsWith('/v1/messages/count_tokens')) return 'count_tokens';
  if (path.endsWith('/v1/messages')) return 'messages';
  if (/\/v1\/messages\/.+/.test(path)) return 'unsupported-subpath';
  return null;
}
