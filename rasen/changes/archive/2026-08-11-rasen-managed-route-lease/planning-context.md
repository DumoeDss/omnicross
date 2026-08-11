# Planning context

## User intent

`$rasen-auto small-feature docs/design/rasen-managed-route-lease-requirements.md 开始开发吧！`

Implement the complete requirements baseline in
`docs/design/rasen-managed-route-lease-requirements.md` through the explicit
`small-feature` pipeline.

## Orchestration decisions

- Change: `rasen-managed-route-lease`
- Pipeline: `small-feature` (explicit user selection; do not reclassify)
- Decomposition: not applicable to this pipeline
- Gate policy: `off` from global config; gated stages are auto-approved and
  must still be recorded in run-state
- Host/tier: Codex native, Tier A
- Role runtimes: planner, implementer, reviewer, fixer, and shipper all resolve
  to Codex native dispatch
- Keepalive: no project/global override; registry default is enabled, but Codex
  native workers are one-shot per the pipeline playbook

## Constraints

- Treat the UTF-8 requirements document as the authoritative baseline and cover
  every MUST requirement.
- Preserve existing user changes and the untracked requirements document.
- Do not modify user-global Codex or Claude configuration as part of the
  implementation.
- Append durable planning discoveries and decisions to this file.

## Durable codebase discoveries

- `ProviderProxyRouteMap` already owns the single resident token-to-`RouteContext`
  map, 32-byte random token minting, exact fail-closed lookup, and 10-minute
  lookup-touched idle reaping. Route Lease work should extend this map with
  same-token renew/activity/eviction seams and an absolute manager TTL, not add a
  second proxy or router.
- `GatewayBindingTarget`, `gatewayBindingToEndpointConfig()`, and the outbound
  route resolver already encode provider key, strict account, account-group, and
  account-pool hints. Lease target resolution should refactor/reuse those pure
  semantics with an ephemeral `fallback: fail` projection and never persist a
  binding or consult a global default.
- The current Codex launch builder still uses `OPENAI_API_KEY` plus
  `requires_openai_auth=true`; this is the required replacement point for the
  dedicated `OMNICROSS_CODEX_ROUTE_TOKEN` `env_key`. The Claude builder already
  has the required proxy/token/non-secret-sentinel/frozen-model environment and
  should be factored into the shared pure descriptor path.
- `AdminServer` already enforces its configured control token, but the general
  dashboard can be LAN-bound. Route Lease handlers therefore need their own
  `req.socket.remoteAddress` loopback check and must ignore forwarded headers.

## Locked implementation decisions

- Lease TTL is absolute, defaults to 600 seconds, and is capped at 3600 seconds;
  proxy activity updates diagnostics but does not create an unbounded lease.
  Explicit renew re-arms both the manager deadline and the same route token.
- Idempotency is scoped by normalized consumer plus a 1-256 character safe key
  and a canonical semantic-payload hash. A live replay retains the exact
  descriptor only in memory; terminal transitions immediately drop token and
  descriptor secrets and allow later recreation with a new lease id.
- Session attribution stores only a domain-separated HMAC made with a
  process-random key. Token-bearing create results and token-free metadata/result
  DTOs remain distinct types to make accidental list/get/renew leakage harder.
