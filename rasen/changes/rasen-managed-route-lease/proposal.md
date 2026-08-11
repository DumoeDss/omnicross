## Why

Rasen currently cannot ask the long-running OmniCross daemon for a short-lived, process-local routing identity without also launching a terminal or creating persistent gateway configuration. A machine-callable Route Lease control plane is needed so each workflow stage can bind a runtime, upstream resource, and model safely while reusing the resident proxy and leaving the user's Codex and Claude configuration untouched.

## What Changes

- Add a daemon-lifetime Route Lease manager over the existing resident `ProviderProxy` route map, with cryptographically independent tokens, bounded TTL, renew/release, idempotent creation, rollback, expiry, and shutdown cleanup.
- Add authenticated, loopback-only Admin API endpoints to create, inspect, renew, release, and discover capabilities for Route Leases without launching any process.
- Accept the existing provider/account/account-group/account-pool target union, preserve strict resource-selection semantics by default, and statically preflight credentials, model eligibility, transformer compatibility, and runtime adapters before registering a route.
- Return argv-safe Claude Code and Codex launch descriptors. Codex uses a dedicated `OMNICROSS_CODEX_ROUTE_TOKEN` custom-provider `env_key`, while Claude receives only the resident proxy URL, lease token, non-secret sentinel, and frozen model.
- Separate token-bearing create responses from token-free metadata DTOs; add bounded execution attribution, domain-separated session hashing, stable structured errors, no-store responses, and automated secret-redaction coverage.
- Refactor the existing terminal-launch path to share the same route creation and descriptor service while retaining terminal launch, persistent GatewayBinding, IntegrationManager, and non-lease proxy behavior.
- Add deterministic unit, HTTP integration, concurrency, regression, and real-CLI E2E coverage, including proof that no user CLI config or credential files are modified.

## Capabilities

### New Capabilities

- `rasen-managed-route-leases`: Versioned, ephemeral route leasing for Rasen-managed Claude and Codex stages, including target resolution, lifecycle, Admin API, launch descriptors, isolation, diagnostics, capability discovery, and compatibility guarantees.

### Modified Capabilities

None. The repository has no existing main spec whose required behavior changes; existing terminal launch, persistent gateway, and integrations remain compatibility constraints of the new capability.

## Impact

- Core provider-proxy routing and route-map lifecycle (`packages/core/src/provider-proxy`) gain lease-aware registration, renewal, activity, expiry, target-resolution, and descriptor services while retaining one resident router.
- Daemon bootstrap and Admin control-plane routing (`packages/daemon/src/bootstrap.ts`, `packages/daemon/src/admin`) gain the manager lifecycle and versioned Route Lease HTTP API.
- CLI launch builders and dashboard/CLI terminal launch (`packages/cli-launcher/src/proxy-env`, `packages/daemon/src/admin/cliLaunch.ts`, `packages/daemon/src/commands/launch.ts`) consume the shared descriptor/lease service; the Codex per-process override contract changes from `OPENAI_API_KEY`/`requires_openai_auth` to a dedicated `env_key`.
- Tests span core route resolution and lifecycle, daemon HTTP integration and shutdown, CLI launch descriptor/regression suites, and opt-in real Codex/Claude executable E2E. No new persistent key/binding records or user-global configuration writes are introduced.
