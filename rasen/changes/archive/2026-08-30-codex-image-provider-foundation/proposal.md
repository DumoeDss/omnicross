## Why

Omnicross has no image-domain seam that both the Images API and Responses hosted image tool can safely share, so adding either protocol surface now would duplicate upstream assumptions and artifact handling. This foundation must freeze provider-neutral contracts first, while refusing to advertise or invoke unverified ChatGPT/Codex subscription capabilities.

## What Changes

- Add dependency-light image request, capability, event, usage, error, cancellation, artifact, and reference contracts without exposing ChatGPT/Codex private wire fields.
- Add a core `ImageProvider` registry and deep `ImageOrchestrator` module that selects a provider, intersects capability evidence fail-closed, enforces event/terminal/count invariants, propagates cancellation, and records only bounded metadata.
- Add artifact/reference ports that preserve tenant isolation, TTL/expiry semantics, opaque upstream references, and content-sensitive handling for later Images API and Responses callers; this change defines and tests the ports but does not implement a generic Files API or production storage backend.
- Add an isolated Codex/ChatGPT subscription image adapter foundation that reuses injected subscription authentication/account selection, keeps private request/response parsing inside `@omnicross/subscriptions`, and maps only verified upstream outcomes to stable core events/errors.
- Add fake-provider and redaction/error fixtures for contract tests. Successful private-wire fixtures may be added only when derived from a verified, sanitized upstream capture; otherwise the production adapter reports capability as unavailable/unknown and fails closed.
- Keep `/v1/images/*`, Responses `image_generation` execution, permissions/configuration, daemon/UI composition, queues, and live capability probing in the dependent sibling Changes.

## Capabilities

### New Capabilities

- `image-provider-foundation`: Provider-neutral image contracts, capability evidence intersection, orchestration, cancellation, stable errors/usage, and artifact/reference lifecycle ports.
- `codex-subscription-image-adapter`: An isolated, redaction-safe ChatGPT/Codex subscription adapter that dispatches only with verified account/upstream capability evidence and treats unknown private protocol or entitlement as unsupported.

### Modified Capabilities

None.

## Impact

- Adds image-generation contract exports under `packages/contracts/src`, the owned `packages/core/src/image-generation/**` module and exports, and an image adapter module under `packages/subscriptions/src`.
- Adds direct contract tests in contracts/core/subscriptions and package export/build updates where required.
- Does not modify `packages/core/src/openai-operation/**`, `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts`, or `packages/core/src/provider-proxy/ingress/providerProxyShared.ts`.
- Establishes the interfaces consumed by `codex-images-api-surface`, `codex-responses-image-tool`, and `codex-images-production-wiring`; no endpoint, registry contribution, or host wiring is delivered in this slice.
