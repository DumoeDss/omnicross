/**
 * Auth-header keys the ProviderProxy strips from transformer-chain config before
 * merging, so the proxy's own provider-key auth (via `getProviderHeaders`) is
 * never clobbered. Local copy of the host proxy's `AUTH_HEADER_KEYS` — kept
 * here so the resident proxy does not import the host's legacy proxy
 * module graph (parity with that constant verbatim).
 *
 * @module provider-proxy/authHeaderKeys
 */

export const AUTH_HEADER_KEYS = new Set(['authorization', 'x-goog-api-key', 'x-api-key']);
