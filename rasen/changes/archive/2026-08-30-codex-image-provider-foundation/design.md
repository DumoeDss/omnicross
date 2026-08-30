## Context

Omnicross currently has text-oriented provider dispatch, account scheduling/authentication, proxy-aware egress, usage/audit seams, and a fixed Codex subscription profile pointing at the verified text Responses endpoint. It has no image-domain contracts or image artifact lifecycle. The existing `fetchUpstream` diagnostic trace captures relay bodies verbatim unless its body-redaction option is set, which is unsafe for prompts and image Base64.

Session B owns `packages/core/src/image-generation/**` and the subscriptions image adapter, while another session owns Native Responses core/profile work. This Change therefore cannot edit `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`, and must not add endpoint handlers or compose a Responses hosted tool. The current repository contains no verified sanitized successful ChatGPT/Codex subscription image exchange and no account-level image entitlement field; successful text Responses traffic is not proof of image access.

The design treats the core image layer as a deep module: protocol frontends learn one normalized request/result interface, while provider choice, account-bound capability verification, event validation, cancellation, artifact retention, and metadata-only observability remain local to the module.

## Goals / Non-Goals

**Goals:**

- Freeze stable, provider-neutral image request, capability, event, error, usage, cancellation, artifact, and reference contracts consumed by all later image surfaces.
- Add a deterministic registry and one orchestrator whose interface is the shared test surface for Images API and Responses integrations.
- Bind capability evidence and upstream execution to the same selected subscription account.
- Keep all ChatGPT/Codex private wire knowledge and credential handling inside subscriptions and fail closed when evidence is missing or stale.
- Make content-bearing data unavailable to ordinary logging/audit interfaces by construction.

**Non-Goals:**

- No `/v1/images/generations`, `/v1/images/edits`, multipart/JSON parser, SSE formatter, or operation registry contribution.
- No Responses request recognition, tool-choice logic, `image_generation_call` mapping, or changes to concurrent Core-owned files.
- No independent images permission/configuration, queue, persistent filesystem store, daemon/UI/doctor/model-list wiring, or live entitlement probe.
- No generic Files API, remote URL downloader, stored/background Responses, compact, WebSocket, standalone web search, or Codex host `$imagegen` claim.
- No fabricated successful subscription fixture, usage, moderation result, transparent image, partial image, entitlement, cost, or private-protocol stability claim.

## Decisions

### 1. Put serializable public vocabulary in contracts and behavior behind one core module

Add `packages/contracts/src/image-generation-types.ts` for provider-neutral value types and stable code unions, export it through the contracts barrel/subpath/package build. Add `packages/core/src/image-generation/**` for behavioral interfaces and implementations, exported as `@omnicross/core/image-generation` and from the core barrel. Candidate files are `ImageProvider.ts`, `ImageProviderRegistry.ts`, `ImageOrchestrator.ts`, `capabilities.ts`, `errors.ts`, `ports.ts`, and `index.ts`, with tests colocated under `__tests__`.

The contracts layer holds no host path, HTTP request/response, credential, private provider field, or storage implementation. Runtime asset handles live at the core seam and expose trusted metadata plus a bounded `ReadableStream<Uint8Array>` opener; provider requests never receive raw multipart fields, URLs, data URLs, or public file IDs.

Alternative considered: keep all types in core. Rejected because subscriptions, daemon wiring, and future consumers need a dependency-light shared vocabulary and the repository already uses explicit contracts subpaths for that role.

### 2. Acquire an account-bound provider lease instead of separate capability and generate/edit calls

The external provider interface has one acquisition entry point:

```ts
interface ImageProvider {
  readonly id: string
  acquire(context: ImageProviderContext): Promise<ImageProviderLease>
}

interface ImageProviderLease {
  readonly providerId: string
  readonly capabilities: ImageCapabilities
  start(request: NormalizedImageRequest): ImageJob
  release(): Promise<void>
}
```

`NormalizedImageRequest` is a discriminated `generate | edit` union, so one `start` method covers both actions. The lease is short-lived and holds selected-account/auth state privately. `ImageOrchestrator.run(request, context)` acquires once, validates against `lease.capabilities`, starts once, validates the event stream, and releases exactly once on every exit. `ImageOrchestrator.getCapabilities(context)` may acquire/release without starting a job for later management views.

Alternative A used separate `getCapabilities`, `generate`, and `edit` calls. It is familiar but allows a pooled account to change between capability lookup and dispatch. Alternative B let `start` internally decide support and returned no inspectable snapshot; it avoided a race but made non-consuming capability discovery impossible. The lease combines the small interface of B with truthful per-account discovery.

### 3. Represent capability inputs as evidence layers and publish only the resolved snapshot

Core defines a pure `resolveImageCapabilities` function over three typed layers: adapter declaration, selected-account evidence, and observed-upstream protocol evidence. Evidence carries a source, verification time, optional expiry, and partial capability values. True/available requires affirmative, fresh agreement from every required layer; absence is unknown and resolves false. Sets intersect, maxima take the minimum, and contradictions produce a stable unavailable reason. Raw evidence detail remains trusted-process state; callers see a resolved snapshot and safe reason code.

The Codex adapter's default evidence source returns unknown because the current repository proves only the text Responses endpoint. A later explicit live doctor or trustworthy non-consuming account metadata can write evidence; a user toggle and the string `gpt-image-2` cannot.

Alternative considered: publish optimistic static capabilities and wait for upstream rejection. Rejected because it can consume subscription quota, silently mis-advertise transparency/partial support, and violates Session B's fail-closed requirement.

### 4. Make an asynchronous event job the single execution result

`ImageJob` exposes an `AsyncIterable<ImageProviderEvent>` plus idempotent `cancel`. Events are `accepted`, `partial_image`, `completed`, or `failed`. Binary artifacts use bytes/streams internally, never Base64; protocol frontends encode only at their final wire boundary. The orchestrator enforces accepted-before-output, monotonic partial indexes, independently decodable partial artifacts, one terminal, no post-terminal events, and exact final count. Iterator throws become safe stable failures.

`accepted` is the retry boundary: failures after it are not automatically retried without explicit upstream idempotency proof. A caller abort invokes job cancellation once, prevents further binary forwarding, and resolves as `request_cancelled`.

Alternative considered: return a promise for non-stream output and add a separate streaming method. Rejected because it creates two lifecycle/cancellation implementations and would force Images and Responses frontends to diverge.

### 5. Separate binary asset access from public references

Core defines two injected ports:

- `ImageAsset`/asset resolver contracts expose validated MIME, byte length, dimensions, alpha/hash metadata, and a bounded readable stream, hiding local paths and original carriers.
- `ImageReferenceStore` saves final content or an opaque provider reference under a tenant and random public ID, resolves to `found | expired | not_found`, returns a lease that pins active content, and supports explicit deletion/cleanup.

The orchestrator accepts a reference-retention policy from its trusted caller and uses the store only when a later frontend needs multi-turn retention. Cross-tenant lookup returns `not_found`; only the owning tenant can observe `expired`. The foundation supplies test doubles, not a production filesystem store and not public Files routes.

Alternative considered: expose local temp paths or Base64 directly. Rejected because paths leak host policy and Base64 multiplies memory/copies across layers. A generic Files abstraction is also rejected for this Change because Session B excludes the product-wide Files API.

### 6. Use stable failures and optional upstream usage

`ImageGenerationError` carries a stable code, safe message, optional public parameter, HTTP hint, retry timing, and coarse verified moderation detail. Original upstream cause/body stays non-enumerable or trusted-only and is never serialized. Stable codes cover invalid request/model/capability, auth, not-found/expired, size/type, moderation, rate/subscription limits, cancellation, protocol drift, generation failure, and timeout.

Completed events omit `usage` unless the adapter validates real upstream values. The image usage shape contains no default-zero rule and no dollar-cost field. The metadata sink may separately record `usageUnavailable: true`.

Alternative considered: reuse text `UsageTokens`, whose documentation defaults missing counts to zero. Rejected because that semantic would fabricate image usage and cannot express image-token detail truthfully.

### 7. Introduce an image-specific metadata sink rather than reuse body audit capture

`ImageOrchestrator` takes an optional `ImageTelemetrySink` whose record shape has no prompt, content, Base64, URL, credential, raw reference, or account-ID field. It contains request/provider/model/action, safe enums, counts, byte sizes/dimensions, timing, stable terminal code, and usage availability. Sink errors are swallowed.

Alternative considered: pass image requests through the existing body audit/redaction path. Rejected because truncation/redaction cannot safely prove arbitrary binary/Base64 removal and duplicates large content before it can be scrubbed.

### 8. Build the Codex adapter as a private-wire module with mandatory sensitive egress

Add `packages/subscriptions/src/image-generation/**` with a public provider factory/class typed only against the core seam and unexported private modules for candidate request construction, response/event parsing, capability evidence, and redacted error classification. Lease acquisition reuses the existing Codex `AuthStrategy`: `reportSelection` captures the actual account ID, headers remain lease-private, and a single 401 refresh is allowed through `onUnauthorized` before acceptance.

The transport uses the existing proxy-aware `fetchUpstream` seam with body capture forcibly disabled (`redactBodies: true`) for every image call; this is not caller-configurable. It forwards only metadata for proxy/account attribution. The adapter must never embed inbound Omnicross authorization.

No successful private-wire golden fixture is created from imagination. Core orchestration uses a synthetic fake provider. Subscription success behavior is enabled/tested only when a verified sanitized capture exists with provenance; absent that, negative auth/capability/protocol/redaction tests are the honest exit and the production adapter remains unavailable.

Alternative considered: add image fields to `SubscriptionProviderRegistry`'s text dispatch profile or reuse text transformers. Rejected because it leaks image/private-wire assumptions into the shared text path and risks modifying files owned by the concurrent Responses session.

### 9. Preserve explicit integration seams for sibling Changes

The foundation exports the image module and adapter factory but no operation registrations. `codex-images-api-surface` will adapt JSON/multipart and export `images.generate`/`images.edit` contributions. `codex-responses-image-tool` will adapt hosted-tool execution and export the injectable contribution. `codex-images-production-wiring` will supply storage, queues, capability evidence/probe policy, permissions/configuration, daemon/UI composition, and safety budgets. All three must use the frozen orchestrator and reference ports rather than copy provider logic.

## Risks / Trade-offs

- [No verified live subscription image exchange exists] → Ship a useful core/fail-closed adapter foundation and mark live capability unverified; never create a positive fixture or advertise a model until evidence exists.
- [Provider lease holds bearer headers briefly] → Keep it short-lived, never serialize/log it, release on every path, and bind cancellation to acquisition and execution.
- [A stale capability snapshot could outlive account/upstream change] → Evidence has expiry; every new lease resolves fresh evidence and unknown/stale values become unsupported.
- [Existing upstream trace captures relay bodies] → Image transport hardcodes body redaction even when debug trace is enabled and tests assert the trace contains markers/metadata only.
- [Streams and artifact leases can leak resources] → Orchestrator owns finally-release, cancel-on-abort, one terminal, and test doubles that count opens/releases.
- [Strict exact-count and fail-closed rules reduce apparent compatibility] → Prefer explicit `unsupported_capability`/failure to incomplete output or silent option substitution.
- [Contract churn could block dependent children] → Treat specs and core interface tests as the compatibility gate; later changes consume only exported interfaces.

## Migration Plan

1. Add contract types/subpath exports with no existing behavior change.
2. Add the isolated core image module, fake adapters/stores, and interface-level tests.
3. Add the dormant fail-closed Codex subscription adapter and redaction/negative tests; do not register it at bootstrap in this Change.
4. Run focused tests, package typechecks/builds, and secret/UTF-8/diff checks.
5. Dependent Changes wire one frontend at a time. Rollback is removal of the unregistered exports/modules; existing text serving remains untouched.

## Open Questions

- Which trustworthy signal can prove a selected ChatGPT/Codex account's image entitlement without spending quota? Until answered, the account evidence source remains unknown and production availability false.
- Is the subscription image exchange exactly the existing private Responses endpoint with the public `image_generation` tool shape? Only a permitted live capture can answer; public docs and text traffic do not.
- Does a verified upstream return durable image IDs, raw bytes/Base64, or both? The reference port supports either without exposing the private form.
- Which later host module owns persisted evidence and production reference storage? `codex-images-production-wiring` must decide without changing the frozen core seam.
