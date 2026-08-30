# Codex Images production wiring verification

## Candidate identity

- Change: `codex-images-production-wiring`
- Branch: `feat/codex-hosted-tools-and-images`
- Merge-base baseline: `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594`
- Branch HEAD before the uncommitted candidate diff: `bee04cc3f9f72150138f7a740034dd9659b46282`
- Candidate under test: that HEAD plus the current uncommitted worktree diff. Nothing was committed, pushed, archived, or applied to parent run-state.
- Runtime: Node `v24.14.0`, npm `11.9.0`, OpenAI JS `7.8.0`, Python `3.12.4`, OpenAI Python `3.5.0`.

## Deterministic Tier A verification

Tier A uses the labeled synthetic verified-provider seam inside the real daemon composition. It proves local authorization, routing, OpenAI protocol compatibility, persistence, scheduling, and cleanup. It does not prove Codex subscription entitlement or private-wire stability.

| Command | Result |
| --- | --- |
| `npx vitest run packages/daemon/src/__tests__/image-daemon-openai-sdk.test.ts --maxWorkers=1` | Passed, 4/4 tests. |
| `npx vitest run packages/daemon/src/__tests__/image-daemon-python-sdk.test.ts --maxWorkers=1` | Passed, 3/3 tests with pinned `openai==3.5.0`; generate, multipart edit/mask, exact error parsing, and process-cancellation cleanup were exercised. |
| `npx vitest run packages/daemon/src/__tests__/image-daemon-lifecycle-e2e.test.ts --maxWorkers=1` | Passed; default-disabled, permission update, selected-account scheduling, hot reload/rollback, restart persistence, and metadata-only surfaces were exercised. |
| `npx vitest run <13 mapped security files> --maxWorkers=1` | Passed, 13 files and 140 tests. The exact files cover path, container/pixel, overflow, queue/store/tenant/evidence/remote/header/race cases listed in task 7.1. |
| `npx vitest run packages/daemon/src/image-generation/__tests__/imagesConfigValidation.test.ts packages/daemon/src/image-generation/__tests__/ImageApiRuntimeResolver.test.ts packages/daemon/src/image-generation/__tests__/ImageRuntimeGenerationFactory.test.ts packages/daemon/src/__tests__/admin-images-config.test.ts packages/core/src/image-generation/openai-images/__tests__/safeRemoteResolver.test.ts --maxWorkers=1` | Passed, 5 files and 50 tests. Production remote loading remains disabled without an injected proven resolver. |
| `npm run typecheck` | Passed for contracts, core, subscriptions, cli-launcher, daemon, and UI. |
| `npm run build` | Passed for contracts, core, subscriptions, cli-launcher, daemon, and UI. Vite emitted only its non-fatal existing large-chunk warning. |
| `npm test -- --maxWorkers=1` | Final rerun passed: 342 files passed, 3 skipped; 3230 tests passed, 8 skipped. Duration 1189.31 seconds. |

The first full-suite attempt passed 340 files / 3228 tests and exposed two deterministic fixture defects: a daemon test placed application data above its fake home, and a spend-window test assumed the run day was not Sunday. The fixtures were corrected to use a private sibling daemon root, real returned Responses IDs, and a fixed Wednesday. Their isolated reruns and the final full suite passed.

## Focused regression slices

- Chat, Responses, Messages, and Gemini: 29 files / 375 tests passed.
- Native integration keys, exact key policy, and route leases: the slice passed after building its documented `@omnicross/cli-launcher` dist prerequisite; the isolated lifecycle rerun passed 11 tests with 1 platform skip.
- Audit, billing, and proxy: 24 files / 227 tests passed in the aggregate; `auditDictionary.test.ts` exceeded its 5-second limit under aggregate load, then passed 10/10 in isolation.
- Subscription accounts and bootstrap: 26 files / 212 tests passed.
- UI adapters and public exports: 16 files / 87 tests passed.

## Failure-atomic and lifecycle proof

- Server config prepare/persist/publish/rollback: `serverConfigTransaction.test.ts`, `admin-images-config.test.ts`, and lifecycle E2E cover validation, prepare failure, persistence failure, injected publish failure, rollback, secret preservation, and coherent successful publication.
- Storage: `FileImageReferenceStore.test.ts`, `FileResponsesImageStateStore.test.ts`, `ImageStorageMountCatalog.test.ts`, `ImageStartupReconciler.test.ts`, and `imagePersistenceHardening.test.ts` cover atomic manifests, quotas, leases, tenant isolation, corruption, symlink swaps, restart, known-empty state, mount migration, and bounded recovery.
- Scheduler and temporary lifecycle: `ImageExecutionScheduler.test.ts`, `imageTemporaryResources.test.ts`, and provider scheduler tests cover per-account limits, fair tenant rotation, global waiting bounds, separate queue/generation clocks, cancellation, exact-once release, and zero workspace writes.
- Daemon lifecycle: composition and lifecycle E2E cover first-proxy registry injection, stable one-time registration, reset/rebuild, hot-reload generation pinning, draining, stop, and metadata-only status/audit.

## Security and repository gates

- Secret gate scanned 121 changed/new text files. Production/config/evidence had zero high-confidence private-key, OpenAI/Anthropic/GitHub/AWS token, JWT, long Bearer, session Cookie, or machine-specific path findings. Five findings were synthetic redaction/migration fixtures under `__tests__` and were reviewed with matched values suppressed.
- No changed runtime logs, JSONL stores, databases, or image/binary artifacts exist in the repository.
- Strict UTF-8 gate: 121/121 text files decoded strictly; zero BOM, U+FFFD, mojibake signatures, trailing whitespace, or conflict markers.
- Structured data: 3 changed JSON files parsed; no changed TOML/YAML files exist.
- `git -c core.safecrlf=false diff --check` passed, and the scoped path allowlist had zero out-of-scope paths.
- Forbidden gate had zero changed paths under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, `providerProxyShared.ts`, or `packages/core/src/provider-proxy/responses/**`; added code had zero excluded Files, compact, Responses WebSocket, web-search, stored, or background Responses surface.
- The hosted factory has production references only in its definition, daemon bootstrap handle, and public export. Production code never calls `acquire()` and performs no Responses ingress injection.

## Capability matrix

| Capability | Status | Evidence / limit |
| --- | --- | --- |
| OpenAI Images generate HTTP protocol | Supported, Tier A | JS and Python SDKs passed through the bound daemon with the synthetic verified provider. |
| OpenAI Images edit + mask HTTP protocol | Supported, Tier A | JSON reference and multipart edit/mask mapping passed locally. |
| Stream/non-stream local mapping | Supported, Tier A | Local protocol mapping and cancellation paths passed; this is not a production Codex feature claim. |
| Explicit Images key permission | Supported | Legacy absent permissions remain four-family text-only; explicit empty denies all; native integration keys remain Responses/Messages only. |
| Production Codex effective generate | Unavailable / unverified | Default disabled and fail-closed without fresh selected-account evidence. Tier B was not run. |
| Production Codex edit/mask | Unsupported / unverified | The current subscription adapter does not claim this capability. |
| Partial images / transparency | Unsupported / unverified | Never inferred from synthetic or config evidence. |
| Moderation detail / revised prompt | Unsupported / unverified | Omitted unless actually observed; no live observation exists. |
| Usage / cost | Unsupported / unknown | No invented zero values or claims. |
| Persistent tenant references / Responses image state | Supported, Tier A local | Restart, tenant isolation, leases, quotas, expiry, and known-empty state passed. Production provider availability remains evidence-gated. |
| Remote image URLs in production | Disabled / unsupported | Admin and runtime fail closed without a proven composed resolver. |
| Hosted Responses image factory | Available and dormant | `createHostedImageContributionFactory`, `HostedImageContributionFactory`, and `HostedImageRuntimeGenerationLease` are public daemon exports. |
| Final Native Responses ingress injection | Not implemented / out of scope | No forbidden ingress or Responses core file changed. |
| Tier B `doctor images --live` | Not run / unverified | No explicit live-usage approval was provided. No consuming request was made. |
| Tier C Codex `$imagegen` host | Not run / unsupported for this child | No explicit opt-in was provided, and final Responses ingress integration is intentionally absent. No script fallback was used. |

## Optional live gates

`doctor images --live` was deliberately not run. The current session had no explicit approval to consume subscription quota. The Codex custom-provider `$imagegen` host gate was also not run because there was no explicit opt-in and this child does not contain final Responses ingress injection. These rows remain honest `not run`, `unverified`, or `unsupported`; Tier A results are not substituted for them.
