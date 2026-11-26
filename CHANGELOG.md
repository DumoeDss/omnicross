# Changelog

All `@omnicross/*` packages are released in lockstep. This file starts with the
embedding API. Earlier releases are described in their GitHub release notes.

Public-API stability during 0.x: breaking changes to `@omnicross/daemon/embed`
are listed under **Breaking (embed API)** in the release that makes them.

## Unreleased

### Added: embedding entry `@omnicross/daemon/embed` (new public API)

Runs the provider, key-pool, subscription-account, sign-in and route-lease
runtime in-process for another Node application, without the gateway (8765),
the admin server (8766), the UI or any file outside the host's `dataDir`. See
[docs/embedding.md](docs/embedding.md).

- `createEmbeddedHost(options): EmbeddedHost` with `start()` / `stop()`,
  `leases`, `providers` (+ `keys`), `presets`, `upstreams`, `accounts`,
  `oauth`, `health()` and `on('change')`.
- `createRouteLeaseDescriptors(options)`: CLI launch descriptors with
  host-chosen identifiers (no product name by default).
- `HostError`: the single error type (stable `code`, HTTP-style `status`).
- `OMNICROSS_MASTER_KEY` is ignored by default (`masterKey.readEnv: false`).

### Added: in-process route-lease support (`@omnicross/core`)

- `runtime: 'endpoint'` with `wire: 'anthropic-messages' | 'openai-responses' |
  'openai-chat'` for SDKs that need only `{ baseUrl, token, wire }`. It is
  opt-in (`RouteLeaseManager` options `endpointRuntime` / `exposeEndpoint`).
  The daemon's HTTP lease API keeps rejecting it, and its responses are
  unchanged.
- The provider proxy accepts the route token in `x-api-key` (after
  `Authorization` and `x-goog-api-key`).
- `ProviderProxy.start({ host, port })` for a pinned loopback listener.

### Changed

- The daemon's provider, key-pool, preset, account and sign-in admin handlers
  are now thin wrappers over a shared service layer (`service/providerAdmin`,
  `service/accountAdmin`, `service/oauthAdmin`). HTTP behaviour is unchanged.
- `sharp` is loaded on first image decode instead of at import, so importing
  `@omnicross/core` or `@omnicross/subscriptions` no longer loads libvips.
- `resolveMasterKey` accepts `readEnv: false`; `SecretBox` accepts a custom
  decrypt-failure message; the OAuth loopback callback page title and hint are
  configurable.
