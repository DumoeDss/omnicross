# Image provider foundation apply evidence

## Baseline and scope

- Baseline / starting HEAD: `eb2d20a8278870f36af2996914b831f7b8446484`.
- Branch: `feat/codex-hosted-tools-and-images`.
- This child implements only provider-neutral contracts/core orchestration/reference ports and the isolated subscriptions adapter foundation.
- It does not add Images API routes, Responses hosted-image execution, permissions/configuration, or daemon/UI composition.
- No file under `packages/core/src/openai-operation/**`, and neither `openaiResponsesIngress.ts` nor `providerProxyShared.ts`, is modified.

## Truthful capability matrix

| Capability | Foundation implementation | Live Codex/ChatGPT subscription status |
|---|---|---|
| Provider-neutral generate/edit requests | Implemented and tested | Not an entitlement claim |
| Three-layer capability intersection | Implemented; unknown/stale/contradictory evidence fails closed | Account and observed-protocol evidence absent by default |
| Non-stream generation adapter path | Candidate mapping is isolated and negative-tested | Unverified / unavailable in production |
| Edit, mask, multiple input images | Core contracts/orchestrator validation implemented | Adapter declaration does not support it in this slice |
| Partial image events | Core lifecycle implemented and fake-provider tested | Live upstream partials unverified / unsupported |
| Transparent output | Core capability validation implemented | Live upstream alpha/transparency unverified / unsupported |
| Usage and revised prompt | Optional, allow-listed, never defaulted | Omitted unless response-field provenance is separately verified |
| Moderation detail | Stable coarse contract exists | No category/score is invented |
| Artifact/reference retention | Tenant-safe leased port and in-memory test double implemented | Persistent production backend belongs to production wiring |
| Codex host `$imagegen` | Not part of this child | Not established |

No positive private-wire golden fixture was added because no permitted, sanitized successful subscription image exchange is available. Text Responses success, public documentation, configuration flags, and `gpt-image-2` names do not enable the provider.

## Exported integration interfaces

### `@omnicross/contracts/image-generation-types`

- `NormalizedImageRequest`, `NormalizedImageGenerateRequest`, and generic `NormalizedImageEditRequest<TAsset>`.
- `ImageCapabilities`, `ImageCapabilityEvidenceLayer`, `ImageProviderEvent<TArtifact>`, optional `ImageUsage`, stable public error/reason unions.
- `ImageArtifactMetadata`, branded public artifact/reference IDs, and the sensitive opaque-provider-reference marker.

### `@omnicross/core/image-generation`

- `ImageProvider`, account-bound `ImageProviderLease`, `ImageJob`, and `ImageProviderRegistry`.
- `ImageOrchestrator.run()` / `getCapabilities()` with capability, lifecycle, cancellation, retention, and telemetry enforcement.
- `ImageAsset`, `ImageReferenceStore`, `ImageReferenceLease`, `ImageTelemetrySink`, plus bounded/in-memory test implementations.
- `resolveImageCapabilities` and safe `ImageGenerationError` helpers.

### `@omnicross/subscriptions`

- `createCodexSubscriptionImageProvider(options): ImageProvider`.
- Safe `CodexImageCapabilityEvidenceSource` request/result interfaces.
- Private endpoint/envelope/parser/error symbols are deliberately absent from the package barrel.

The Images API child should normalize JSON/multipart inputs into `ImageAsset` handles and invoke the orchestrator. The Responses child should map the same event stream and retained references into hosted-tool output. Production wiring should inject a persistent reference store, telemetry sink, real evidence source, provider registration, permissions, queueing, and host configuration without changing the frozen provider seam.

## Verification executed during apply

- Review-cycle round 1 fixes:
  - Candidate PNG/JPEG/WebP output now requires a complete container and a bounded full `sharp@^0.35.4` pixel decode before an asset can be marked independently decodable; valid VP8/VP8L and truncated raster fixtures are covered. The subscriptions package now truthfully requires Node `>=20.9`, matching the decoder runtime floor.
  - Raw selected account IDs remain available only to proxy/allowance/route attribution; debug trace emission receives a SHA-256 fingerprint, with a raw-sentinel JSONL regression test.
  - HTTP 429/500/503/504 and connection-reset failures remain retry-unknown; only controlled 401/403 authentication rejection proves `before_acceptance`. Orchestrator start/iterator uncertainty follows the same rule.
  - All seven touched pre-existing CRLF files (the six reported files plus `upstreamFetch.ts`) were mechanically normalized back to CRLF.
- Focused Vitest: 8 files, 71 tests passed.
- Typecheck: `@omnicross/contracts`, `@omnicross/core`, and `@omnicross/subscriptions` passed.
- Build: all three workspaces passed ESM, CJS, and DTS generation.
