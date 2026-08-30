## Why

The three prerequisite image Changes now provide a provider/orchestrator foundation, OpenAI Images contributions, and an injectable Responses hosted-image contribution, but all remain dormant outside test harnesses. Omnicross needs a production host boundary that grants Images access explicitly, binds real account-scoped runtimes, owns bounded storage and scheduling, and advertises only fresh evidence-backed capability before the parent Change can be shipped honestly.

## What Changes

- Add an explicit `images` key permission whose legacy/default absence denies Images without changing existing Chat, Responses, Messages, or Gemini access; route authenticated `/v1/images/generations` and `/v1/images/edits` to the exported contributions without pre-reading JSON or multipart bodies.
- Add a default-off, strictly normalized Images server configuration with migration-safe defaults, provider/account binding, API/resource/time budgets, daemon-private temporary and persistent storage policy, and generation-safe hot reload in which new requests use the new snapshot while accepted work finishes on its pinned runtime.
- Build app-session image composition: register the Codex subscription image provider and the two Images operation contributions, resolve trusted tenant/provider/account inputs, and expose an acquireable hosted-image contribution/factory for a later Responses integrator without modifying or injecting into Responses ingress here.
- Add an independent fair image queue, per-account concurrency, queue/generation timeouts, parent cancellation, globally and per-tenant bounded temporary resources, and persistent tenant-scoped reference/Responses-image state with atomic writes, TTL/byte/count quotas, leases, startup recovery, and cleanup.
- Add evidence-backed capability projection to `/v1/models`, authenticated admin/UI status, and `doctor images`; normal discovery is non-consuming, while only explicit `--live` may spend subscription usage and may persist narrowly observed positive evidence after a strictly validated real exchange.
- Add metadata-only image audit/metrics and body-capture suppression for image requests/results, plus secret scans covering credentials, prompts, URLs, masks, Base64, paths, raw account IDs, and private provider references.
- Complete daemon-wired JavaScript/Python SDK and boot/security regressions, and add an opt-in current-Codex `$imagegen` host gate whose unavailable or failed result is reported as unsupported rather than replaced with a script or synthetic success.
- Keep standalone web search, compact, Responses WebSocket, generic Files API, stored/background Responses, and final Responses ingress injection out of scope. Do not fabricate entitlement, usage, moderation, partial images, transparency, cost, or private-wire stability.

## Capabilities

### New Capabilities

- `images-access-and-runtime-wiring`: Explicit Images authorization, own-body outbound dispatch, app-session registry/provider composition, account-bound runtime resolution, and the dormant hosted-image integrator factory.
- `images-production-configuration`: Default-off Images configuration, strict migration/validation, safe storage/provider policy, non-disruptive generation-pinned hot reload, and admin/UI editing.
- `images-production-lifecycle`: Independent fair scheduling, timeouts/cancellation, persistent tenant-scoped artifacts and Responses image state, quotas, leases, crash recovery, and cleanup.
- `images-capability-observability`: Real-evidence capability/model advertising, admin/UI/doctor surfaces, metadata-only audit/metrics, redaction, and honest SDK/Codex host verification.

### Modified Capabilities

None.

## Impact

- Extends outbound authorization/config/router/status/model-list behavior in `packages/core/src/outbound-api/**` and the existing Images resource-scope ports, while leaving the forbidden shared operation/Responses files untouched.
- Adds production image runtime, persistence, evidence, scheduling, admin capability, doctor, and bootstrap/start wiring under `packages/daemon/src/**`, with safe adapter-probe/scheduler additions under `packages/subscriptions/src/image-generation/**` where required.
- Extends API Service DTOs/adapters/hooks/components, key permissions, image configuration/capability status, queue status, endpoint URLs, and translations under `packages/ui/src/**`.
- Registers `images.generate` and `images.edit` through the existing app-session `OpenAIOperationRegistry`; exports—but does not inject—the hosted Responses image contribution/factory.
- Must not edit `packages/core/src/openai-operation/**`, any `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.
