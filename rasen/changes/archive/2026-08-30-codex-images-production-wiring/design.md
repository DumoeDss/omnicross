## Context

The three prerequisite child Changes are implemented and review-clean. `@omnicross/core/image-generation` now exports an account-bound `ImageProvider`/`ImageOrchestrator`, bounded image assets, `ImageReferenceStore`, `createImageApiContributions`, and `createResponsesImageGenerationContribution`. `@omnicross/subscriptions` exports `createCodexSubscriptionImageProvider`, but its production evidence source is intentionally unknown: the repository still contains no permitted sanitized successful subscription image exchange or account entitlement signal. The current adapter declaration implements only one non-stream generate output and explicitly does not claim edit, mask, partial streaming, transparency, Responses-tool, or multi-turn support.

The outbound server authenticates named keys, applies a generic text concurrency gate, reads JSON to route text requests, then replays the body into the resident `ProviderProxy`. The shared operation classifier already labels Images operations as extension-owned and configured-model operations, while the provider-proxy registry dispatches extension handlers before reading a body. Production currently constructs no `OpenAIOperationRegistry`, so both Images contributions remain dormant. The existing request audit can capture complete response bodies—including Base64/SSE—when body capture is enabled and therefore cannot wrap Images traffic unchanged.

The daemon owns config persistence/hot reload, subscription account strategies, file-backed ports, admin routing, doctor commands, and UI data. Session B forbids edits under `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, and `providerProxyShared.ts`. This Change may expose a hosted-image contribution/factory from daemon composition, but final Native Responses selection/terminal assembly and ingress injection remain a later integrator responsibility.

## Goals / Non-Goals

**Goals:**

- Make Images authorization an explicit, independently editable key permission that legacy, unrestricted, Responses-only, and native integration keys do not acquire by upgrade.
- Register and serve the exported Images contributions through a trusted, own-body path using one production provider/orchestrator/reference stack.
- Bind configured Codex provider/account selection, capability evidence, queue admission, dispatch, and attribution to the same request/runtime generation.
- Add strict default-off configuration and non-disruptive hot reload for provider, account, limits, queue, remote URL, retention, and storage policy.
- Persist image artifacts and Responses image call/response state under tenant, byte, count, TTL, lease, crash-recovery, and startup-cleanup bounds.
- Advertise models/features only from fresh effective evidence, supply non-consuming admin/UI/default-doctor diagnostics, and put any consuming verification behind explicit `doctor images --live`.
- Suppress content-bearing audit capture and expose only bounded low-cardinality image metrics/audit metadata.
- Prove daemon composition with official SDKs and report live subscription/Codex host capability without substituting synthetic evidence.

**Non-Goals:**

- No modification of the operation classifier/registry implementation or the two forbidden ingress/shared files.
- No injection of the hosted image contribution into Native Responses, no main-model selector, and no official terminal Responses event assembly in this Change.
- No standalone web search, compact, Responses WebSocket, generic Files API, stored/background Responses, or DALL·E/variations support.
- No optimistic capability from a config toggle, model name, public documentation, text Responses success, or synthetic fixture.
- No invented subscription usage/cost, moderation detail, transparent output, partial image, revised prompt, entitlement, or private-wire guarantee.

## Decisions

### 1. Separate serving permission from the four text routing endpoints

Keep `OutboundEndpoint = chat | responses | messages | gemini` as the downstream-binding/routing vocabulary and introduce an `OutboundPermission = OutboundEndpoint | images` vocabulary for named keys. `allowedEndpoints` becomes the permission list without forcing Images into text `GatewayBinding` or `EndpointRoutingConfig` semantics.

One helper is authoritative for authorization. An absent legacy list means the four legacy permissions only; it never includes `images`. An explicit list is exact, including an empty deny-all list. `createIntegrationKey` retains `responses/messages` and therefore never gains Images. Add an atomic DB/admin setter for the exact permission list, strict duplicate/unknown validation, and UI checkboxes. Existing key rows migrate by interpretation, not rewrite.

Alternative considered: add `images` to `OutboundEndpoint`. Rejected because Images has configured-model, binary-owning handlers and a provider/account policy rather than a text model binding; making it a fifth text route would spread false `IngressFormat`, role, model-map, and binding assumptions. Alternative considered: treat an absent list as all five permissions. Rejected because a Responses key would silently gain a high-cost binary endpoint.

### 2. Give Images an own-body branch in the authenticated outbound router

`selectEndpoint`/an adjacent classifier projects `images.generate` and `images.edit` to the new permission family. After key authentication and rate limiting, but before downstream binding lookup, generic body reading, generic text concurrency, audit-body stashing, or billing conversion, the router checks explicit Images permission and the live image runtime. It creates a minimal trusted image `RouteContext` containing `apiKeyId`, configured model/provider, session key, and account/group hints, then dispatches the already-classified operation through the app-session `OpenAIOperationRegistry` with the original request stream.

The branch never calls `readBody`, creates a replay request, hashes a raw bearer into a tenant, or passes the bearer upstream. The contribution remains responsible for bounded JSON/multipart consumption. Unregistered/disabled runtime stays fail-closed with a safe unsupported error. The generic text concurrency gate is skipped; the image scheduler below is independent.

Alternative considered: buffer multipart in `outboundApiRouter` and replay it. Rejected because it defeats Busboy streaming, duplicates large bodies, and violates the Images contribution contract. Alternative considered: call handlers without the registry. Rejected because the requested integration seam is app-session registry composition and uniqueness/disposal must remain centralized.

### 3. Add one strict nested Images config segment

Add `server.images` with an equivalent normalized structure:

```ts
interface ImagesServerConfig {
  enabled: boolean
  provider: 'codex-subscription'
  defaultModel: string
  modelAliases: Record<string, string>
  account: {
    id?: string
    group?: string
    fallback: 'strict' | 'pool'
  }
  queue: {
    maxConcurrentJobsPerAccount: number
    maxQueuedJobs: number
    queueTimeoutMs: number
    generationTimeoutMs: number
  }
  temporary: {
    maxActiveScopes: number
    maxTotalBytes: number
    maxTenantBytes: number
    staleAfterMs: number
    cleanupIntervalMs: number
  }
  limits: ImageApiLimits
  references: {
    ttlMs: number
    maxTotalBytes: number
    maxTenantBytes: number
    maxEntries: number
    maxCalls: number
    maxResponses: number
    maxTombstones: number
    tombstoneTtlMs: number
    cleanupIntervalMs: number
    storageRoot?: string
  }
  remote: { enabled: boolean }
  evidenceTtlMs: number
}
```

Missing/malformed legacy config normalizes to `enabled:false`, the current `gpt-image-2` default, `maxConcurrentJobsPerAccount:1`, `maxQueuedJobs:20`, a 120-second queue timeout, a 180-second generation timeout, the already-frozen `DEFAULT_IMAGE_API_LIMITS`, finite active-scope/temporary-byte ceilings, a 24-hour reference TTL, finite store/state quotas, and remote URLs disabled. Core normalization remains tolerant for reads; the admin PUT edge is strict and rejects unknown provider values, simultaneous account id/group, unsafe roots, hard-ceiling violations, non-positive budgets, and inconsistent aggregate limits. Default durable and temporary roots come from a daemon-owned private application-data root outside every detected Git worktree; an explicit root inside a worktree or through a symlink is rejected. The UI edits the same segment and labels unverified capability separately from configuration.

Alternative considered: scatter environment variables across the daemon. Rejected because migration, admin validation, hot reload, UI state, and reproducible doctor output need one persisted source of truth.

### 4. Use a runtime-generation manager for non-disruptive hot reload

Add `packages/daemon/src/image-generation/ImageRuntimeManager.ts`. A generation owns a config snapshot, provider registry/provider, orchestrator, scheduler binding, actual Images contributions, capability resolver, and hosted contribution. Stable forwarding handlers are registered once; each request acquires the current generation, delegates to its actual contribution, and releases only after handler cleanup. A hosted factory similarly returns a generation lease containing the `ResponsesImageGenerationContribution`; the final integrator must hold it until its request scope is disposed.

Admin config apply runs as a transaction: normalize and validate the merged document; prepare the replacement Images generation and any fallible listener/runtime changes without publishing them; atomically persist the staged settings; then publish the prepared participants. Publication is designed as an infallible pointer/snapshot swap after preparation. A persistence failure disposes the prepared generation, and any unexpected publish failure rolls back every already-published participant plus the persisted previous document before returning failure. No success response or applied audit event is emitted until persisted settings, the outbound listener snapshot, and the Images generation agree. New requests then see the new snapshot immediately. Queued/accepted requests retain the old generation and its timeout/provider behavior; retirement waits for zero request/scope leases before disposal. Provider, account binding, storage-root, and remote-policy changes produce metadata-only audit events.

The storage catalog is longer-lived than one runtime generation. On storage-root change it switches new writes to a newly validated backend but retains old backends in a versioned mount manifest until their last reference expires or is migrated, so hot reload does not make published call IDs disappear. Cleanup retires empty old mounts. This also survives daemon restart.

Alternative considered: unregister and re-register contributions on every PUT. Rejected because duplicate-registration windows and in-flight handler closure state make atomicity/disposal fragile. Alternative considered: mutate one provider/orchestrator in place. Rejected because accepted work must retain its original limits, timeout, evidence, and storage policy.

### 5. Compose the existing public seams once at daemon boot

Before the first `getProviderProxy` call, bootstrap creates an `OpenAIOperationRegistry`, the persistent store catalog, evidence store, scheduler, observability sink, and `ImageRuntimeManager`. It obtains the existing Codex `AuthStrategy` from `subscriptionAccounts.getStrategy('codex')` (the dispatch-profile `SubscriptionProviderRegistry` does not expose strategies), constructs `createCodexSubscriptionImageProvider`, registers it in `ImageProviderRegistry`, constructs one `ImageOrchestrator` using the same `ImageReferenceStore` later supplied to the hosted contribution, and registers the manager's stable `images.generate`/`images.edit` forwarding contributions. The registry is injected into `ProviderProxyDeps` on the first construction at the current bootstrap seam.

The Images runtime resolver accepts only `route.apiKeyId` as tenant ID, maps configured provider/model/aliases/limits and account hints, injects the common reference store and remote resolver only when enabled, and creates a keyed irreversible `user` fingerprint. The raw bearer, selected account ID, credential headers, and private wire never enter core request values.

The returned daemon handle exposes an acquireable `hostedImageContributionFactory` with the exact order documented by the Responses sibling: existing affinity authorization first; acquire generation; inspect/validate real selection; create one scope; execute selected calls with the integrator's global allocator; commit before terminal success; dispose and release in `finally`. This Change does not call that factory from `openaiResponsesIngress.ts`.

Alternative considered: create separate providers/stores for Images and Responses. Rejected because Session B requires one orchestrator, one capability truth, and one reference lifecycle.

### 6. Put fair account admission inside the subscription adapter boundary

The selected Codex account is known only after `AuthStrategy.applyHeaders(reportSelection)` inside the subscription provider. `CodexSubscriptionImageProviderOptions` currently exposes only `authStrategy`, `evidenceSource`, `generationTimeoutMs`, and `now`, so add an optional structural execution-scheduler hook; its input contains trusted tenant ID, an opaque scheduling account key, signal, and config-generation snapshot, but it cannot inspect credentials or bodies. The daemon implements a hierarchical gate with per-account active limits and round-robin tenant queues under one bounded global queue.

Queue admission occurs after account/evidence resolution but before transport and before `accepted`. Cancellation removes a waiter immediately. Queue timeout maps distinctly from generation timeout and makes no upstream call. A granted slot is released exactly once after terminal, throw, iterator return, or cancellation. The adapter's generation timeout begins only after grant. The current adapter's `maxOutputImages:1` means `n>1` remains an honest capability rejection; no hidden fan-out is fabricated.

Alternative considered: gate at the HTTP route. Rejected because the route does not yet know the selected pooled account and capability lookup/dispatch could drift. Alternative considered: reuse the generic outbound key concurrency gate. Rejected because image work must not consume text slots and it cannot enforce per-subscription-account safety.

### 7. Implement a versioned persistent reference/store catalog

Add daemon implementations of `ImageReferenceStore` and `ResponsesImageStateStore` under a daemon-owned private application-data `images/` root by default, never the worktree. Binary files and metadata use unpredictable IDs, restrictive creation, verified descendant paths, no caller filenames, atomic temp-write/fsync/rename publication, and versioned manifests. A persistent random local HMAC salt turns tenant/key IDs into stable store keys; raw tenant/account identifiers are not written. Opaque provider references are omitted when a retained artifact is sufficient or encrypted with the existing host secret box when persisted.

`save` enforces per-artifact hard limits plus total bytes, per-tenant bytes, and entry counts before publication. Cleanup removes abandoned temp files, invalid/incomplete transactions, expired/deleted unleased entries, and then bounded capacity candidates; active leases pin bytes. Cross-tenant lookups are not-found, owner expiry uses bounded tombstones, and capacity eviction remains not-found. On startup, manifests are strictly decoded and reconciled against files without following symlinks; corrupt entries are quarantined or removed without serving bytes.

The persistent Responses state store preserves atomic multi-call commits, ordered/known-empty response entries, exact idempotency, owner-only expiry, capacity outcomes, and call/reference links from the implemented in-memory contract. A coordinator consumes evicted/expired call bindings, deletes their reference artifacts best-effort, runs both cleanups at startup and on an unref'ed interval, and reports counts/bytes only.

The existing `ImageRequestResourceScope` defaults directly to the OS temporary directory and only accounts bytes within one request. Production therefore injects a daemon-owned temporary root plus a shared budget port covering active scopes, total bytes, and per-tenant bytes. Every chunk reservation is charged before write and released on spool disposal or scope cleanup. Request directories carry an owner marker and unpredictable name; startup cleanup removes only verified stale directories owned by this daemon schema, never an arbitrary prefix match. Queue admission does not replace this ingress budget because edit bodies are parsed before the subscription account is selected.

Alternative considered: use the in-memory stores in production. Rejected because multi-turn references would disappear on restart and there would be no disk/tenant byte enforcement. Alternative considered: expose the store as Files API. Rejected because Session B excludes a generic Files product surface.

### 8. Suppress general body audit and add structural image observability

Classify the operation before `beginAuditCapture` and pass a content-capture suppression option for Images. The normal audit record may retain method, path, status, safe model/provider, duration, and key ID, but `beginAuditCapture` must not wrap `res.write`/`res.end`, and the router must not call `setRequestBody`, for Images even if global `captureBodies` is true. Images handlers still use their injected `ImageApiAuditRecord`, and the orchestrator uses `ImageTelemetrySink`.

Daemon `ImageObservability` combines those metadata-only records into bounded counters/histograms for request/success/failure/cancel, endpoint/provider/model/action/enums, queue wait, first partial/final latency, input/output counts and bytes, stable error code, retry/auth-refresh count when actually known, and reference hit/expiry/cleanup. Dimensions are allow-listed and low-cardinality. There is no prompt, image/mask, Base64/data URL, URL query, path, credential, Cookie, raw tenant/account ID, or provider reference field. Admin/diagnostic output uses only the same projection; logs and snapshots run sentinel scans.

Alternative considered: improve regex redaction for Base64. Rejected because body capture can copy arbitrarily large sensitive images before redaction and no regex can distinguish every legitimate opaque payload safely.

### 9. Treat capability as a non-consuming read plus a separate consuming verifier

The production evidence store implements `CodexImageCapabilityEvidenceSource`, keyed internally by the selected-account HMAC. Normal Images requests, `/v1/models`, admin status, UI polling, and default doctor only read fresh evidence and call `ImageOrchestrator.getCapabilities`; none generates an image. Missing/stale/failed evidence remains unavailable.

Add a subscriptions-owned `CodexImageLiveVerifier` so private candidate wire construction/parsing never enters daemon/core. Only `doctor images --live` invokes it, prints a quota warning before the call, performs one low-quality PNG generate with body tracing forced redacted, strictly decodes the artifact, then destroys it. A successful exchange can persist narrowly observed account/upstream evidence (for example model, one-output non-stream generation, the exact tested quality/format) with source/version/time/expiry; it cannot assert edit, masks, partials, transparency, Responses tool, arbitrary formats/qualities, usage, moderation, or cost. Any auth/limit/moderation/protocol failure persists no positive capability.

`/v1/models` appends `gpt-image-2` only for an explicitly Images-authorized key, enabled configuration, matching configured provider/account, and fresh effective availability. Auto model-list shape chooses OpenAI when a key explicitly includes Images; a forced Anthropic shape may omit the image model rather than emit an invalid wire. The authenticated admin capability endpoint returns the more precise feature/limits/reason/evidence-age view and never probes.

Alternative considered: probe on first request or model-list read. Rejected because discovery must not spend quota. Alternative considered: persist full upstream responses as evidence. Rejected because they contain prompts/images/private schema and violate the redaction boundary.

### 10. Expose capability and policy in daemon/UI without claiming support

Add a focused authenticated AdminServer route such as `GET /admin/api/images/capabilities` plus safe runtime/queue/store status. `GET/PUT /admin/api/server` carries the normalized config. API Service UI adds an Images card showing configured versus effective status, safe unavailable reason, verified-at/expiry, endpoint feature matrix, model, reference TTL, queue/store utilization, remote URL policy, and a warning that configuration is not entitlement. Key management edits exact permissions and visually distinguishes `responses` from `images`.

Outbound status adds generation/edit URLs and image queue counts without changing existing four text URLs. UI/admin output does not expose storage paths, account IDs, evidence blobs, prompts, image hashes, or secret-bearing diagnostics.

Alternative considered: place `gpt-image-2` in the static subscription catalog. Rejected because catalog presence would be mistaken for account entitlement and would advertise before evidence.

### 11. Use three explicit verification tiers

Tier A is deterministic local protocol/runtime evidence: existing image unit/security suites plus real daemon boot with a synthetic verified provider; current stable JavaScript and pinned Python OpenAI SDKs must generate and edit through the registered endpoints, and text endpoint boot/golden regressions stay green. Synthetic tests may prove multipart/mask/partial/transparency behavior only as protocol support.

Tier B is optional consuming subscription evidence: `doctor images --live` records exactly what one real sanitized exchange proved. Absence/failure is published as live subscription unavailable/unverified, not converted to a test pass.

Tier C is a current Codex custom-provider `$imagegen` host gate in an isolated temporary home/config. It verifies whether the host actually emits the supported Responses image tool path and can consume a result. If the host lacks the tool or final ingress injection is absent, the matrix and PR say unsupported; no CLI script fallback is accepted. The daemon still exposes the hosted contribution factory and exact future integration order.

Alternative considered: let the HTTP SDK tests stand in for Codex host support. Rejected because the requirements explicitly separate HTTP, raw Responses, and host tool discovery.

## Risks / Trade-offs

- [No verified subscription image exchange exists today] → Keep default capability false; local tests use labeled synthetic providers and only explicit live doctor can create narrow expiring evidence.
- [The current adapter implements generation only] → Register both public endpoints but let edit/mask/partial/transparency/Responses-tool requests fail `unsupported_capability`; publish the split between protocol support and live provider support.
- [Persistent image bytes are sensitive and large] → Use private roots, restrictive atomic files, four-dimensional quotas, short TTL, leases, startup cleanup, no body logging, and no public file routes.
- [Storage-root hot reload can strand old IDs] → Keep a durable mounted-backend catalog and retire old roots only when empty; failed mount publication leaves the current generation/store active.
- [Queue hooks see an account scheduling key] → Keep it trusted-process-only, transform it to a local HMAC before storage/metrics, and never place it in public errors or audit.
- [Model discovery may refresh OAuth metadata] → Permit non-consuming auth/evidence reads but no generation; document that a forced Anthropic model-list shape can omit Images rather than emit the wrong schema.
- [General audit currently wraps responses early] → Classify first and structurally suppress capture before installing wrappers; secret-sentinel tests cover JSON, multipart, SSE, admin, logs, snapshots, and diagnostics.
- [Hot reload expands lifecycle complexity] → Centralize generations, leases, and retirement in one manager; stable registry handlers and a failure-atomic swap make tests deterministic.
- [Final Responses integration is absent] → Expose the hosted factory and integration contract, keep its capability status separate, and make the Codex host gate honestly unsupported until the later integrator lands.

## Migration Plan

1. Add permission/config types, defaults, strict admin validation, exact key-policy mutation, and a prepare/persist/publish/rollback coordinator while Images remains default-disabled and cannot serve.
2. Add persistent evidence/reference/state stores, daemon-owned temporary budgets, startup recovery, cleanup coordinator, scheduler, and metadata-only observability with isolated tests.
3. Add the runtime-generation manager, Codex provider composition, stable registry handlers, own-body outbound dispatch, and truthful model/admin capability projections.
4. Add doctor/UI/status/permission editing, then daemon-wired JavaScript/Python SDK and boot/security tests. Run optional live/Codex gates only when their prerequisites are explicitly supplied.
5. Hot apply ordinary config through generation swaps. Storage format/root changes publish a new mounted backend only after validation; rollback restores the previous persisted document and published snapshots while leaving accepted work/references intact.
6. Parent delivery records the capability matrix and hosted factory. A later final integrator injects that factory into Native Responses; this child does not edit ingress.

## Open Questions

- Which permitted real subscription exchange, if any, will be available during implementation to seed Tier B evidence? Until one succeeds, all live rows remain unavailable.
- Does the current Codex host expose `$imagegen` to a custom Responses provider? The Tier C gate answers this for the tested version; absence is a supported release-note outcome.
- Should encrypted-at-rest image payloads be mandatory beyond restrictive local files on every supported platform? The store design leaves a streaming codec seam, but implementation must not add whole-file memory copies merely to claim encryption.
- Which later integration owner will mediate the main-model selection and terminal Responses assembly? The daemon factory is intentionally insufficient without that explicit selector/allocator/affinity integration.
