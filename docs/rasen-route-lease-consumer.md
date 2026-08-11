# Rasen Route Lease consumer guide

Route Leases let a Rasen stage obtain a short-lived Claude Code or Codex routing identity from an already-running OmniCross daemon. A lease reuses the daemon's resident proxy, freezes one upstream and model, and disappears on release, expiry, or daemon shutdown. It does not create a Gateway key or binding and does not modify either CLI's global configuration.

## Preconditions

Before sending credentials or creating a lease, the consumer must validate the configured daemon URL:

- The URL must use a loopback host such as `127.0.0.1`, `[::1]`, or a locally resolved `localhost`.
- Do not trust `X-Forwarded-For`, `Forwarded`, or another caller-supplied header when deciding whether the endpoint is local.
- Send the configured Admin control token as `Authorization: Bearer <token>` on every Route Lease request.
- If no Admin token is configured, warn clearly and refuse any non-loopback endpoint. The current server independently rejects every non-loopback Route Lease socket peer even when forwarded headers claim otherwise.
- Never log the Admin token, `Idempotency-Key`, create request/response body, or the returned launch environment.

The first request should discover the daemon contract:

```http
GET /admin/api/route-leases/capabilities
Authorization: Bearer <admin-control-token>
```

Version 1 returns:

```json
{
  "schemaVersion": "omnicross.route-lease.capabilities/1",
  "runtimes": ["claude", "codex"],
  "upstreamKinds": ["provider", "account", "account-group", "account-pool"],
  "leaseApiVersion": 1,
  "codexAuthMode": "env_key",
  "maxTtlSeconds": 3600
}
```

Reject an incompatible major schema or a daemon that does not advertise the requested runtime, upstream kind, or Codex `env_key` mode.

## Create a lease

Create requires the versioned JSON body and a caller-generated idempotency key. The key must contain 1–256 ASCII characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, or `-`. Scope it to one logical stage attempt, for example `rasen:<run>:<stage>:<attempt>`.

```http
POST /admin/api/route-leases
Authorization: Bearer <admin-control-token>
Content-Type: application/json
Idempotency-Key: rasen:run-123:apply:1
```

```json
{
  "schemaVersion": "omnicross.route-lease.request/1",
  "consumer": "rasen",
  "runtime": "codex",
  "upstream": {
    "kind": "provider",
    "providerId": "deepseek-api"
  },
  "model": "deepseek-chat",
  "execution": {
    "runId": "run-123",
    "stageId": "apply",
    "attempt": 1,
    "sessionId": "rasen-session-affinity-value"
  },
  "ttlSeconds": 600
}
```

Supported upstream targets are:

```ts
type RouteLeaseUpstream =
  | { kind: 'provider'; providerId: string; keyId?: string }
  | { kind: 'account'; providerId: string; accountId: string }
  | { kind: 'account-group'; providerId: string; group: string }
  | { kind: 'account-pool'; providerId: string };
```

`provider.keyId`, `account`, and `account-group` are strict boundaries. They never fall back to another key, account, group, or global provider. Only the explicit pool target uses the provider's eligible account pool. Creation performs static resource, credential, model, proxy-readiness, runtime-adapter, and transformer preflight; it does not make an upstream model request.

A new lease returns `201 Created`. An identical retry while the lease is active returns `200 OK` with the same `leaseId` and exact descriptor. Reusing the same live key for a different semantic payload returns `409 idempotency_conflict`. Both successful statuses include `Cache-Control: no-store`.

Only the successful create response contains the route bearer token:

```ts
interface RuntimeLaunchDescriptor {
  env: Record<string, string>;
  extraArgs: string[];
}
```

Treat the entire `launch` object as a secret. Do not persist it in a Rasen run record, print it, include it in an error, or send it to telemetry.

## Spawn the runtime directly

Merge the descriptor into the child environment and append its individual arguments before Rasen-owned arguments. Use a direct process spawn with `shell: false`:

```ts
const child = spawn(runtimeCommand, [
  ...lease.launch.extraArgs,
  ...rasenOwnedArgs,
], {
  cwd: workspace,
  env: { ...process.env, ...lease.launch.env },
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

The descriptor never owns prompt, sandbox, approval, output-schema, structured-output, or resume arguments. Rasen remains responsible for those arguments and must keep each one as a separate argv element. Never join `extraArgs` into a shell command.

For Codex, the only route secret is `OMNICROSS_CODEX_ROUTE_TOKEN`. The descriptor selects the reserved `omnicross` provider, `responses` wire API, loopback `/openai` base URL, `env_key="OMNICROSS_CODEX_ROUTE_TOKEN"`, and disabled response storage. Do not copy the token to `OPENAI_API_KEY` and do not add `requires_openai_auth`.

For Claude, the descriptor contains the resident `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, the non-secret `ANTHROPIC_API_KEY=omnicross-proxy` sentinel, and `ANTHROPIC_MODEL`.

Rasen must not read or write any of these user-global files as part of a leased run:

- Codex `config.toml` or `auth.json`;
- Claude settings or credential files;
- OmniCross persistent Gateway key/binding configuration.

## Renew while the stage is alive

Every lease has an absolute TTL. Runtime traffic updates `lastActivityAt` but does not extend `expiresAt`. For a long stage, renew before the deadline; a practical policy is half the requested TTL with bounded jitter.

```http
POST /admin/api/route-leases/<leaseId>/renew
Authorization: Bearer <admin-control-token>
Content-Type: application/json

{"ttlSeconds":600}
```

Renewal returns only:

```json
{
  "leaseId": "<lease-id>",
  "expiresAt": "2026-08-11T12:10:00.000Z",
  "status": "active"
}
```

It is `Cache-Control: no-store`, does not rotate the token, and never repeats the launch descriptor. A `404 lease_not_found` or `410 lease_expired` means authority is gone: stop using the old child/token and create a new lease from the frozen logical request with a new idempotency key. Do not guess a replacement route.

## Release and recovery

Release in a `finally` block after normal exit, error, cancellation, spawn failure, or orchestration abort:

```http
DELETE /admin/api/route-leases/<leaseId>
Authorization: Bearer <admin-control-token>
```

The first cleanup normally returns `{ "leaseId": "...", "released": true }`. A repeated or unknown delete returns success with `released: false`; cleanup is intentionally idempotent. Stop the heartbeat before or atomically with release so a late renewal cannot race the terminal cleanup path.

If the daemon restarts, old lease ids and route tokens are not recovered. Recreate from Rasen's logical runtime/upstream/model request. Never persist or reuse the former token.

## Token-free inspection

`GET /admin/api/route-leases` returns `{ "leases": [...] }`; `GET /admin/api/route-leases/<leaseId>` returns one metadata object. These projections may contain consumer, runtime, credential-free upstream selector, frozen model, timestamps, status, and bounded execution attribution. They never contain the route token, launch descriptor, raw session id, upstream credential, prompt, or request/response body.

The raw execution `sessionId` is replaced with a process-local, domain-separated hash. Usage can be correlated by `leaseId`, consumer, run, and stage without using the token as an identifier.

## Error handling

Domain failures use this stable envelope:

```json
{
  "error": {
    "type": "route_lease_error",
    "code": "upstream_exhausted",
    "message": "the selected subscription pool has no eligible account",
    "retryable": true
  }
}
```

Important handling rules:

- `invalid_request`, `runtime_unsupported`, `model_not_configured`, and `format_unsupported`: fix the request or capability mismatch; do not retry unchanged.
- `upstream_not_found`: the selected identifier no longer exists; refresh configuration.
- `upstream_unavailable`: a strict resource exists but is disabled or lacks usable credentials; require operator action or an explicit target change.
- `upstream_exhausted`: honor the bounded numeric `Retry-After` header and retry only within the stage's policy.
- `daemon_not_ready`: retry with bounded backoff after confirming the same loopback daemon endpoint.
- `idempotency_conflict`: generate a key for the new semantic request; never overwrite the still-live lease implicitly.
- Admin authentication failures may be returned by the existing Admin gate before the Route Lease error adapter runs.

Never include the original secret-bearing request, descriptor, headers, or child environment when surfacing these errors.

## Non-billable verification and manual smoke

Automated interoperability tests must point the real CLIs through a real local OmniCross daemon to local mock upstreams. Default CI must not use a paid credential. A user-credential smoke is a separate, explicitly invoked operation: require an opt-in flag and user-supplied credential, state that it may incur cost, and snapshot the relevant CLI configuration/credential files before and after.
