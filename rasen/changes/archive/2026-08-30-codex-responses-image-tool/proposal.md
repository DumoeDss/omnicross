## Why

The completed image foundation and Images API surface still cannot participate in an OpenAI Responses conversation: there is no local hosted-tool contribution that can validate `image_generation`, execute an actually selected call through `ImageOrchestrator`, map the official output/events, or preserve tenant-safe image references across turns. This Change supplies that isolated contribution now that the concurrent Native Responses profile has landed, while leaving ingress composition to the final integrator.

## What Changes

- Export a self-contained, non-self-registering Responses `image_generation` contribution with narrow admission, selection, execution, event-allocation, and final-response indexing interfaces for the final integrator.
- Validate the hosted tool declaration, `tool_choice` (`auto`, generic `required`, and forced image generation), `action: auto | generate | edit`, image options, and selected-call contract without inventing an automatic model choice; absent automatic selection remains an ordinary text/other-tool response.
- Resolve explicit call-ID and `previous_response_id` image context through a bounded tenant/outbound-key-scoped index and the existing `ImageReferenceStore`, retaining leases through execution and distinguishing owning-tenant expiry from not-found/cross-tenant access.
- Execute every selected call directly through `ImageOrchestrator`, with `n=1`, real provider partials only, capability rejection, request cancellation, and stable image errors; no internal HTTP round-trip is introduced.
- Map completed calls to `image_generation_call` items whose `result` is bounded Base64, and map real partials to official `response.image_generation_call.partial_image` events using integrator-owned monotonic output/sequence allocation so mixed outputs and multiple calls never assume `output[0]`.
- Add focused tests for automatic/forced/required/no-selection behavior, edit-without-images, unsupported capability, final/partial mapping, cancellation, multiple/mixed calls, multi-turn references, TTL/cleanup/leases, and tenant isolation.

## Capabilities

### New Capabilities

- `responses-image-generation-tool`: Hosted Responses image-tool admission and execution contribution, official result/partial mapping, and tenant-safe multi-turn image reference lifecycle.

### Modified Capabilities

None.

## Impact

- Adds a Responses-specific module and tests under `packages/core/src/image-generation/**` and safe public exports from the existing image-generation/core barrels.
- Reuses `ImageOrchestrator`, `ImageReferenceStore`, stable image errors, bounded asset reads, and the already-landed Responses abort/profile/affinity concepts without changing their owning files.
- Defines the exact injection contract that a final composition change will connect to Native Responses ingress; this Change does not self-register or modify `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.
- Does not add daemon/UI/permission/config wiring, a generic Files API, standalone web search, compact, Responses WebSocket, or stored/background Responses, and does not claim live Codex image capability without fresh entitlement and verified private-wire evidence.
