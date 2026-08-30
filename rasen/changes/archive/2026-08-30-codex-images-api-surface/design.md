## Context

The foundation child already exports provider-neutral image contracts, an account-bound `ImageProvider` lease, `ImageOrchestrator`, bounded `ImageAsset`, tenant-safe `ImageReferenceStore`, stable errors, and a fail-closed Codex subscription adapter. The shared operation layer already classifies `images.generate` and `images.edit` as extension-owned operations and dispatches them before reading the body. Consequently the Images handler, not `providerProxyShared.readBody`, must own bounded JSON/multipart parsing.

The current route handler context contains the authenticated `RouteContext`, request/response, `ProviderProxyDeps`, and a request-lifetime `AbortSignal`. Outbound-key routes expose `route.apiKeyId`, but the raw route bearer must never be reused as tenant identity or upstream authentication. Production permission/configuration, queueing, persistent reference storage, daemon/UI wiring, and app-session registration belong to `codex-images-production-wiring`; Responses hosted-tool execution belongs to `codex-responses-image-tool`.

The foundation review accepted one Minor only because no public route existed: `privateWireResponse.decodeStrictBase64()` runs an anchored quantified regex over a very large candidate before decoded-size rejection and can throw `RangeError: Maximum call stack size exceeded`. This is the first implementation task and a hard prerequisite for exposing either Images contribution.

## Goals / Non-Goals

**Goals:**

- Export registration-ready `images.generate` and `images.edit` contributions without touching concurrent/shared ownership files.
- Normalize OpenAI generation and edit JSON/multipart into the frozen orchestrator seam.
- Enforce byte, part, file, image, pixel, raw-decode, mask, URL, reference, and temporary-resource limits before upstream dispatch.
- Produce bounded OpenAI Images JSON and partial-image SSE with cancellation, backpressure, exact counts, truthful optional usage, and redacted stable errors.
- Exercise the real HTTP shapes produced by current stable JavaScript and Python OpenAI SDKs against a fake provider.

**Non-Goals:**

- No changes under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.
- No Responses `image_generation` recognition/execution/events, previous-response handling, or hosted-tool contribution.
- No images permission, configuration schema/UI, daemon bootstrap, production queue, production reference store, model-list/doctor wiring, or PR-level composition.
- No generic Files API. A `file_id` resolves only through an injected minimal image reference/asset resolver and otherwise fails honestly.
- No stored/background Responses, Responses WebSocket, compact, standalone web search, live entitlement claim, fabricated private-wire fixture, usage, moderation outcome, partial image, or transparent result.

## Decisions

### 1. Keep the protocol frontend inside the owned image module and export data contributions

Add a subtree such as `packages/core/src/image-generation/openai-images/**` and export it through the existing image-generation/core barrels. Its public factory returns data, not side effects:

```ts
interface ImageOpenAIOperationContribution {
  readonly operationId: 'images.generate' | 'images.edit'
  readonly handler: OpenAIOperationHandler
}

interface ImageApiContributions {
  readonly generate: ImageOpenAIOperationContribution
  readonly edit: ImageOpenAIOperationContribution
  readonly all: readonly ImageOpenAIOperationContribution[]
}
```

`createImageApiContributions(deps)` closes over the orchestrator and explicit protocol dependencies. The final integrator iterates `all` and calls the existing registry. The factory never mutates a global registry, so duplicate registration, app-session lifetime, and disposal remain composition concerns.

Candidate modules are `contributions.ts`, `normalizeOptions.ts`, `readJsonBody.ts`, `readMultipartEdit.ts`, `TemporaryImageAsset.ts`, `validateRaster.ts`, `resolveImageInput.ts`, `safeRemoteImageResolver.ts`, `imageApiResponse.ts`, `imageApiSse.ts`, and `imageApiErrors.ts`, with colocated tests. This layout imports existing operation types but does not edit their files.

Alternative considered: add Images branches to `providerProxyRouter` or the shared body reader. Rejected because extension dispatch already provides the seam and Session B expressly forbids moving business logic into shared classifier/ingress code.

### 2. Require an explicit runtime resolver at the contribution boundary

The contribution dependencies include the orchestrator plus an injected resolver that derives safe execution inputs from the authenticated route:

```ts
resolveRuntime(context): Promise<{
  tenantId: string
  providerId: string
  defaultModel: string
  modelAliases: ReadonlyMap<string, string>
  limits: ImageApiLimits
  referenceStore?: ImageReferenceStore
  remoteResolver?: RemoteImageAssetResolver
  fingerprintUser?: (value: string) => string
}>
```

The production-wiring child supplies permission-checked configuration and queues around this seam. In this child, tests inject deterministic values. A default tenant resolver may accept only non-empty `route.apiKeyId`; missing identity rejects rather than hashes the bearer or silently shares a tenant. `user` is passed only through an injected keyed fingerprint function and otherwise omitted.

Limits are explicit and finite: JSON/multipart aggregate bytes, per-file bytes (never above 50 MiB), total decoded input bytes, files (never above 16 references plus one mask), fields/parts/header pairs, pixels (at most 8,294,400 unless a stricter configured ceiling), raw decoded bytes, redirects, URL bytes/time, output artifact bytes, and non-stream/SSE spool bytes. The factory has conservative test defaults but production wiring must provide resolved configuration.

Alternative considered: read `route.model` and process-wide configuration directly. Rejected because Images operations declare configured model selection, route models may originate from text routing, and direct global reads make permission/config hot reload impossible to compose safely.

### 3. Use one strict option normalizer for generation and edit

`normalizeOptions` applies defaults and validates prompt/model/aliases, `n`, quality, GPT Image size, background, format, compression, moderation, stream, partial count, and user fingerprint. The action-specific frontend then adds validated image assets and mask. The normalizer produces only the existing normalized contract.

Size validation implements both 16-pixel multiples, ratio at most 3:1, longest edge at most 3840, and total pixels from 655,360 through 8,294,400. Transparent output is limited to PNG/WebP; compression is limited to JPEG/WebP; partial count is `0..3` and requires streaming. Static validation happens before provider acquisition, while account/provider capability checks remain in the orchestrator lease so capability and dispatch cannot drift.

Unknown request members can be ignored where the current OpenAI SDK adds harmless metadata, but recognized members with wrong types or unsupported semantic switches are rejected. In particular `input_fidelity` is not exposed because this provider path cannot vary it truthfully.

Alternative considered: duplicate generation and edit validation in each handler. Rejected because option drift would make equivalent requests behave differently and weaken SDK contract coverage.

### 4. Stream multipart with Busboy and validate rasters with Sharp

Add `busboy` plus its TypeScript declarations to core and add `sharp` to core's direct dependencies. Sharp is already used and locked by the subscription response decoder, so this does not introduce a second image engine. Busboy is preferred over a bespoke boundary parser because it provides streaming part events and explicit limits; the handler still enforces aggregate observed bytes and treats `filesLimit`, `fieldsLimit`, `partsLimit`, truncation, malformed boundaries, and premature close as terminal local failures.

JSON uses a fatal UTF-8 `TextDecoder` over the request stream with declared and observed caps; `Content-Encoding` other than absent/identity is rejected to avoid a second decompression-bomb surface. Multipart accepts repeated official `image` and compatibility `image[]` fields in arrival order, one optional `mask`, and bounded scalar fields. Caller filenames and content types are metadata only and never determine trusted format or disk path.

Every new image passes a shared Sharp validator configured with `failOn: 'warning'`, `sequentialRead`, finite `limitInputPixels`, one page/frame, and a raw-byte ceiling. It derives PNG/JPEG/WebP from decoded content, validates dimensions/pixels, and forces a complete `raw().toBuffer()` decode one asset at a time before setting `independentlyDecodable`. Signature/header metadata alone is insufficient. A mask must match the first/primary image's decoded format, width, and height and have an actual alpha channel.

Alternative A: reuse declared multipart MIME and parse headers. Rejected because forged MIME, truncation, and compressed pixel bombs remain possible. Alternative B: move Sharp validation to subscriptions. Rejected because multipart/data URL/remote/file carriers are protocol concerns and must fail before selecting or calling any provider.

### 5. Materialize request-scoped inputs as private temporary assets with deterministic cleanup

Multipart files, bounded data URLs, and remote downloads stream into an unpredictable `mkdtemp` directory below an injected safe temp root or `os.tmpdir()`, never below the workspace. Directories/files use restrictive permissions and exclusive creation; caller filenames never enter paths. A `TemporaryImageAsset` exposes trusted metadata and a fresh bounded stream from a private path. It has no public path getter.

The handler owns a request resource scope containing temp assets, open writers, reference leases, and output spools. A single `finally` closes writers/readers, releases leases, and recursively removes only its verified request directory on success, parse failure, provider failure, or abort. Cleanup target resolution is checked to remain under the exact per-request directory. Referenced assets stay pinned through their existing lease until the orchestrator terminates.

Alternative considered: keep all uploaded files in Buffers. Rejected because sixteen large inputs plus mask and raw decode could multiply memory and contradict the streaming multipart requirement.

### 6. Resolve JSON carriers through distinct fail-closed paths

JSON edit refs are a closed union. `file_id` is interpreted only through the injected tenant-scoped `ImageReferenceStore`/minimal resolver; `found` returns a lease, `expired` returns 410 to the owning tenant, and `not_found` hides absent/cross-tenant values. No resolver means `unsupported_capability`, not an invented file object or network fallback.

`image_url` distinguishes bounded `data:image/{png,jpeg,webp};base64,...` from HTTP(S). Data URLs use a manual, length-first Base64 validator and stream decoded bytes into the temp scope. Remote URLs are disabled without an injected resolver. The supplied safe resolver uses manual redirects and an Undici dispatcher/connect lookup that pins an approved address for each hop. It rejects URL credentials and non-HTTP(S), resolves all A/AAAA results, rejects loopback/private/link-local/multicast/unspecified/metadata ranges (IPv4 and IPv6, including mapped forms), pins the connection, re-resolves/revalidates every redirect, limits redirects/time/headers/bytes, and then runs the same raster validator. It never logs full URLs or queries.

Alternative considered: call global `fetch(url, { redirect: 'follow' })` after a one-time hostname check. Rejected because the actual connection can resolve again and redirects/DNS rebinding can cross the approved security boundary.

### 7. Stage non-stream output, but encode SSE incrementally

The orchestrator emits binary assets, not Base64. For non-stream responses, the handler consumes the complete event stream first, rejects unexpected partial events, and Base64-encodes each final asset into secure bounded spool files. Only after every artifact read succeeds does it send HTTP 200, then streams the JSON envelope/spools sequentially while honoring `res.write()` backpressure. This avoids retaining up to ten Base64 strings and avoids committing a 200 response before asset-read failure is known. Unknown usage/revised prompt fields are absent.

For streaming, receipt of the provider `accepted` event commits 200 SSE headers; failures before acceptance can still use the normal JSON status. Each partial asset is bounded-read/encoded and written as one endpoint-specific frame; writes wait for `drain` or abort before pulling more provider events. Completed output emits one indexed completion per final artifact, with verified usage attached only in the canonical final position. Each output maintains its own monotonic `partial_image_index`; no final image is repeated as a fake partial. Client disconnect is already translated by the operation registry into the handler signal and therefore reaches `ImageJob.cancel()` through the orchestrator.

After SSE headers, a non-cancellation failure emits one bounded generic error frame and closes. Cancellation/closed response writes nothing further. All event payloads are serialized from allow-listed fields.

Alternative considered: `JSON.stringify` a full in-memory Base64 response. Rejected because Base64 expands bytes by roughly one third and `n=10` can cause several simultaneous copies. Alternative considered: stream JSON directly from provider artifacts without spooling. Rejected because a late asset read failure would leave a misleading partial 200 JSON document.

### 8. Own image-specific error serialization in the handler

The existing generic operation error is a safe fallback but does not express Images `error.type`, `param`, moderation details, or retry timing. The Images handler catches/normalizes image failures before headers and writes the required snake_case OpenAI envelope. It allow-lists headers (`Retry-After`, `x-request-id`) and maps only stable `ImageGenerationError` data. After headers, the SSE mapper uses the same safe serializer. Unexpected errors become `image_generation_failed`; raw causes and input/upstream excerpts never cross the boundary.

The handler always creates and returns an Omnicross request ID. Audit hooks receive endpoint/action, provider/model, enum options, counts, byte/dimension totals, timing, and stable terminal code only. They never receive prompt, content, path, URL, Base64, credential, account identity, or opaque provider reference.

Alternative considered: rethrow every error to `OpenAIOperationRegistry`. Rejected because it would collapse known image failures into `openai_operation_error` and lose required status/param/moderation semantics.

### 9. Fix private-wire Base64 length and validation before route exposure

Replace the quantified anchored Base64 regex with arithmetic and a linear character-code scan. After confirming a non-empty string and `length % 4 === 0`, derive padding from the final two characters and calculate `decodedBytes = (length / 4) * 3 - padding`. Reject decoded zero/over-50-MiB before validating the full alphabet or calling `Buffer.from`. The scan permits `=` only in the derived final padding positions. Canonical re-encoding remains a post-decode check. Every failure continues through `protocolChanged()`.

Regression tests construct an exact-limit candidate and a limit-plus-one candidate and assert stable `upstream_protocol_changed`, no raw `RangeError`, and no decode call for the over-limit path (via an extracted internal helper or injectable decoder test seam that is not publicly exported). Candidate-tree checks include untracked test files.

Alternative considered: use a simpler full-string regex. Rejected because the existing failure proves regex engine behavior at adversarial length is part of the threat model, even when a different pattern appears linear.

### 10. Test through real HTTP and official SDK constructors

Core tests create a real local `http.Server`, route map, operation registry, both contributions, deterministic runtime resolver, and fake image provider. Direct wire tests cover JSON/multipart limits, MIME lies, corrupt/truncated images, pixel bombs, mask alpha/dimensions/format, multiple references, temporary cleanup, SSRF/redirect/DNS cases, non-stream exact count, SSE order/backpressure/cancellation, redacted errors, and missing capabilities.

Add the current stable JavaScript `openai` SDK as a dev test dependency. Add a small Python SDK contract script and pinned test requirement/lock convention without committing a virtualenv. A Node test launcher starts the same local contract server and invokes Python with an explicitly configured interpreter/environment; if Python or the pinned SDK cannot be provisioned in a developer environment, the verification report records that as unsupported evidence rather than claiming a pass. The delivery gate requires actual JS and Python smoke evidence before the parent PR says AC-13 is met.

No contract test invokes the live ChatGPT/Codex subscription adapter. A verified live capture remains a separate evidence prerequisite; fake provider outputs prove the public protocol, not entitlement.

## Risks / Trade-offs

- [Sharp raw decode allocates up to the configured raw ceiling] → Decode one input at a time, cap pixels/channels/raw bytes, reject animation/multiple pages, and keep encoded inputs on disk.
- [Multipart parser limits can produce several overlapping terminal events] → Funnel parser/request abort/stream errors through one idempotent failure/cleanup scope and test every limit event.
- [Remote URL pinning is platform-sensitive] → Keep remote loading disabled by default, use one tested Undici connector implementation, and reject when address pinning cannot be proved.
- [Non-stream Base64 spooling adds disk I/O] → Prefer bounded disk over unbounded heap copies; clean spools in the same request scope and expose limits/latency in metadata.
- [SSE can fail after HTTP 200] → Use one safe error frame when writable, preserve cancellation semantics, and never re-run after provider acceptance.
- [Official SDK wire shapes evolve] → Run current stable JS/Python constructors against the real local HTTP handler and document the tested versions in evidence.
- [Input/API child touches core while another session changes Responses] → Confine edits to `image-generation/**`, package dependency/export files, and focused tests; candidate-tree forbidden-path checks are mandatory before commit.

## Migration Plan

1. Land the stack-safe Base64 fix and exact-boundary regressions first.
2. Add core dependencies and the isolated parser/asset/validator modules with no registry wiring.
3. Add generation and edit contribution factories plus unit/real-HTTP tests.
4. Add JSON reference/data/remote resolution and security tests, remaining fail-closed when production policy is absent.
5. Add non-stream/SSE writers and official SDK contract harnesses.
6. Run focused tests, core/subscriptions typecheck/build, strict Rasen/UTF-8/secret/diff checks, then commit locally for the parent portfolio. The later production-wiring child registers the contributions; rollback before that is removal of dormant exports/dependencies.

## Open Questions

- Which exact aggregate request/output/temp budgets will production configuration choose below the hard 50-MiB-per-input and 8,294,400-pixel ceilings? The contribution contract requires finite values; the wiring child freezes defaults.
- Does the current stable Python SDK emit repeated `image` or `image[]` for multi-image edit on every supported Python version? The parser accepts both; the SDK contract records the exact tested version and wire.
- Which OpenAI Images streaming optional fields are required by SDK consumers beyond the Session B canonical event names, indexes, Base64, and verified usage? Tests should add only documented fields and tolerate forward-compatible unknown response fields.
- Will production enable remote `image_url` at all? Until the safe resolver and policy are wired and verified, capability remains false and no network request occurs.
- Live Codex subscription entitlement/protocol/partial/transparency remain unverified. Public protocol tests must not change the adapter's fail-closed capability matrix.
