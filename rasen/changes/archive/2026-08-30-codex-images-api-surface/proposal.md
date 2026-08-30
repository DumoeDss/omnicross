## Why

The provider foundation cannot yet be called through OpenAI-compatible Images endpoints, and the current shared router intentionally delegates these extension-owned operations before reading their bodies. This Change supplies the bounded protocol frontend and exported registration seams required for SDK/curl clients, without entering the concurrent Responses or production-wiring ownership areas.

## What Changes

- Export self-contained `images.generate` and `images.edit` operation contributions that a final integrator can register without modifying the shared classifier, registry, or ingress files.
- Normalize generation JSON and edit JSON/multipart requests into the existing `ImageOrchestrator` contract, including model aliases/default injection, `n`, quality, size, background, format/compression, moderation, streaming, partial count, multi-reference inputs, and masks.
- Add bounded request parsing and image-asset validation: byte/count/pixel/decode budgets, signature-derived MIME, independent real decode, alpha/dimension/format mask checks, controlled temporary resources, tenant-scoped injected reference resolution, and fail-closed remote/file references.
- Emit OpenAI-compatible non-stream Base64 responses and backpressure-aware SSE partial/completed/error events with request-lifetime cancellation and stable image-error mapping; never synthesize usage, revised prompts, partial images, transparency, or moderation evidence.
- Fix the foundation private-wire Base64 decoder so over-limit candidates are rejected before stack-sensitive validation/decoding, with exact-limit regressions, before the new public routes can expose it.
- Add protocol, security, cancellation, and JavaScript/Python SDK contract coverage for generation and edit inputs. Live subscription success remains conditional on verified entitlement/private-wire evidence and is not fabricated by this Change.

## Capabilities

### New Capabilities

- `openai-images-api`: OpenAI-compatible generate/edit operation contributions, request normalization, non-stream response mapping, partial-image SSE, cancellation/backpressure, stable errors, and SDK-facing contracts.
- `image-input-validation`: Bounded JSON/multipart ingestion, safe temporary assets, real image decode and metadata validation, mask/multi-reference rules, and injected reference/remote-input resolution with fail-closed security policy.

### Modified Capabilities

None.

## Impact

- Adds an Images protocol frontend module and colocated tests under `packages/core/src/image-generation/**`, plus safe public exports from existing core barrels/build entries.
- Adds or uses a bounded raster decoder and streaming multipart parser dependency only if repository-native facilities cannot meet the stated limits; dependency choice and exact budgets are frozen in design.
- Adds focused regression coverage in `packages/subscriptions/src/image-generation/**` for the pre-route Base64 limit fix.
- Does not modify `packages/core/src/openai-operation/**`, `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts`, or `packages/core/src/provider-proxy/ingress/providerProxyShared.ts`.
- Does not implement the Responses hosted image tool, images permission/config/router/daemon/UI composition, production queues/storage, a generic Files API, stored/background Responses, Responses WebSocket, compact, or standalone web search.
