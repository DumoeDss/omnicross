## 1. Provider-neutral contracts

- [x] 1.1 Add `packages/contracts/src/image-generation-types.ts` with the normalized generate/edit union, capability layer/snapshot values, image artifact metadata, provider events, truthful optional usage, stable error/reason codes, and sensitive opaque-reference markers defined by the two specs.
- [x] 1.2 Export the new contracts from `packages/contracts/src/index.ts`, register the explicit `@omnicross/contracts/image-generation-types` subpath in `packages/contracts/package.json`, and add the file to `packages/contracts/tsup.config.ts`.
- [x] 1.3 Add compile/runtime contract tests under `packages/contracts/src/__tests__/image-generation-types.test.ts` covering discriminated requests, omitted usage, safe serializable error fields, and absence of private Codex/ChatGPT wire fields.

## 2. Core capability and provider seam

- [x] 2.1 Create `packages/core/src/image-generation/capabilities.ts` with a pure three-layer resolver; test stale/unknown evidence, set intersection, minimum numeric limits, contradiction reasons, and the rule that model names never imply features.
- [x] 2.2 Create `packages/core/src/image-generation/errors.ts` with `ImageGenerationError` construction/normalization/serialization helpers and tests proving upstream causes, response excerpts, credentials, prompts, Base64, and account IDs cannot enter the public error shape.
- [x] 2.3 Create `packages/core/src/image-generation/ports.ts` for bounded `ImageAsset`, leased `ImageReferenceStore`, and structurally metadata-only `ImageTelemetrySink` interfaces, plus in-memory test doubles that enforce tenant isolation, same-tenant expiry, active-lease pinning, deletion, and sink-failure isolation.
- [x] 2.4 Create `packages/core/src/image-generation/ImageProvider.ts` with the account-bound provider/lease/job interfaces and create `ImageProviderRegistry.ts` with deterministic registration/resolution and duplicate-ID rejection tests.

## 3. Core orchestrator

- [x] 3.1 Implement `packages/core/src/image-generation/ImageOrchestrator.ts` so one provider lease performs capability validation and job start, every exit releases once, and unsupported action/model/format/count/edit/mask/stream/transparency requirements never invoke `start`.
- [x] 3.2 Add orchestrator lifecycle tests with a synthetic fake provider for accepted/partial/completed ordering, independently readable partials, monotonic indexes, exact final count, iterator throws, duplicate/missing terminal events, and no post-terminal forwarding.
- [x] 3.3 Add orchestrator cancellation/retry-boundary tests proving abort reaches acquisition/assets/job, `cancel` is invoked at most once, binary forwarding stops, pre-accept transport failure remains distinguishable, and no retry occurs after `accepted`.
- [x] 3.4 Integrate optional reference retention and telemetry into the orchestrator and test retained final artifacts, cross-tenant/expired lookup outcomes, cleanup pinning, omitted unavailable usage, metadata-only records, and non-fatal sink failures.
- [x] 3.5 Add `packages/core/src/image-generation/index.ts`, export it from `packages/core/src/index.ts`, and register the `image-generation` subpath entry in `packages/core/tsup.config.ts` without editing `packages/core/src/openai-operation/**` or either forbidden ingress file.

## 4. Fail-closed Codex subscription adapter

- [x] 4.1 Add `packages/subscriptions/src/image-generation/capabilityEvidence.ts` defining the per-account evidence source and a production default that returns unknown/unavailable until fresh entitlement and observed-protocol evidence is supplied; unit-test that text Responses success, config toggles, and `gpt-image-2` names do not upgrade it.
- [x] 4.2 Add unexported private-wire modules under `packages/subscriptions/src/image-generation/` for the candidate verified request/event/response shapes and strict parsers; map malformed HTML/JSON, empty or invalid Base64, count mismatch, and unknown terminal shapes to `upstream_protocol_changed` without embedding body excerpts.
- [x] 4.3 Implement `CodexSubscriptionImageProvider.ts` and its factory using the existing injected Codex `AuthStrategy`: acquire/auth-select one account, resolve that account's evidence before start, keep headers private to the lease, refresh a 401 at most once before acceptance, and release credential-bearing state on every terminal path.
- [x] 4.4 Route every adapter image call through the proxy-aware `fetchUpstream` seam with `providerId/accountId` metadata and forced body redaction; add a debug-trace test proving request/response bodies are redacted while status/timing/byte counts remain and no inbound Omnicross key can become upstream auth.
- [x] 4.5 Add adapter tests for unavailable/auth-required/rate-limit/subscription-limit/moderation/timeout/cancel/protocol-drift mappings, safe `Retry-After`, no post-accept retry, and omission of unverified usage/revised prompt/moderation details.
- [x] 4.6 Export only the provider factory and safe evidence interfaces from `packages/subscriptions/src/index.ts`; keep private wire types/constants unexported and add an import-surface test that core-facing consumers see only `ImageProvider` contracts.
- [x] 4.7 Do not add a positive private-wire golden fixture unless a real permitted upstream exchange is obtained and sanitized; if none is available, add an explicit tested capability-matrix note under `packages/subscriptions/src/image-generation/README.md` marking live entitlement/protocol/partial/transparency/usage as unverified and keep production availability false.

## 5. Verification and handoff evidence

- [x] 5.1 Run focused Vitest suites for `packages/contracts/src/__tests__/image-generation-types.test.ts`, `packages/core/src/image-generation/**`, and `packages/subscriptions/src/image-generation/**`, including secret sentinels for token, Cookie, prompt, image bytes, data URL, and Base64 leakage.
- [x] 5.2 Run `npm run typecheck -w @omnicross/contracts`, `npm run typecheck -w @omnicross/core`, and `npm run typecheck -w @omnicross/subscriptions`, then build those three workspaces once after integration.
- [x] 5.3 Run `rasen validate codex-image-provider-foundation --type change --strict --json`; strictly decode every changed text file as UTF-8, reject BOM/U+FFFD/mojibake, and inspect `git diff --check` plus the diff for unrelated whole-file rewrites.
- [x] 5.4 Confirm the diff contains no changes under `packages/core/src/openai-operation/**`, `packages/core/src/provider-proxy/ingress/openaiResponsesIngress.ts`, or `packages/core/src/provider-proxy/ingress/providerProxyShared.ts`, and record the truthful capability matrix plus the exported interfaces needed by all three dependent Changes in verification/handoff evidence.
