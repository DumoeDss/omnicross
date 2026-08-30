# Codex Images API surface apply evidence

## Baseline, integration state, and ownership

- Required portfolio baseline: `eb2d20a8278870f36af2996914b831f7b8446484`.
- Branch: `feat/codex-hosted-tools-and-images`.
- The latest fetched `origin/main` is `7f14b7c52477ab7cc7f136db3589946216fba922`; merge commit `0b38f35caa1c04225366b61854eb22eda3f8eb99` already reconciles it. The branch is two commits ahead and zero behind that remote tip.
- This child owns the bounded OpenAI Images protocol surface and exports integration contributions. It does not self-register routes or claim production subscription availability.
- The candidate diff contains zero changes under `packages/core/src/openai-operation/**`, `openaiResponsesIngress.ts`, or `providerProxyShared.ts`.

## Public exports and injection contract

`@omnicross/core` and `@omnicross/core/image-generation` export:

- `createImageApiContributions(deps)`, returning frozen, non-self-registering `images.generate`, `images.edit`, and `all` operation contributions.
- `createSafeRemoteImageResolver(options)`, a separately injected, pinned-address remote resolver; remote loading stays disabled when it is not injected.
- `ImageApiContributionsDeps`, `ImageApiRuntimeResolver`, `ImageApiRuntime`, `ImageApiLimits`, `ImageApiAuditRecord`, `ImageOpenAIOperationContribution`, reference/remote materializer types, `DEFAULT_IMAGE_API_LIMITS`, and `assertFiniteImageApiLimits`.

The final integrator must inject an `ImageOrchestrator` and a trusted `resolveRuntime(context)`. Runtime resolution supplies the tenant, provider, default model/aliases, finite limits, and optional reference store, remote resolver, user fingerprint function, and retention policy. Optional request-ID, clock, request resource-scope, and metadata-only audit hooks remain dependency-injected. The operation registry remains the sole registration owner; missing contributions therefore continue to return the established unsupported-operation response.

The next Responses child can reuse the same orchestrator/provider event stream, reference leases, retained artifact IDs, error contract, and trusted runtime concepts. It must export its own hosted `image_generation` execution contribution for injection by the final Responses integrator; this child deliberately does not modify Responses ingress.

## Truthful capability matrix

| Capability | Status in this child | Boundary / evidence |
|---|---|---|
| `POST /v1/images/generations` JSON | Implemented as `images.generate` contribution | Trusted route dispatch, bounded JSON, normalized options, exact-`n` non-stream output, or SSE |
| `POST /v1/images/edits` multipart | Implemented as `images.edit` contribution | Ordered repeated `image`/`image[]`, one-to-sixteen images, optional alpha mask, bounded Busboy streaming |
| JSON edits | Implemented | Accepts exactly one of `image` or ordered `images`; closed data URL / `file_id` / `image_url` carrier objects plus optional mask |
| PNG/JPEG/WebP validation | Implemented | Signature/container checks, single-frame metadata, complete bounded Sharp raw decode, pixel/channel/raw-byte ceilings; animated WebP is rejected |
| Transparent output | Supported when the provider emits a truthful alpha-capable PNG/WebP asset | No transparency is synthesized or claimed from configuration alone |
| Partial image stream | Implemented for provider-emitted complete partial assets | Indexed, monotonic endpoint-specific SSE events; no synthetic partials; backpressure and disconnect cancellation are enforced |
| Multiple outputs | Implemented | Final response is withheld until every exact-`n` output is staged within per-output/aggregate/spool limits |
| `file_id` references | Optional injected capability | Trusted tenant identity, active lease through provider execution, owning-tenant expiry distinction, cross-tenant/not-found hiding; no Files routes added |
| Remote `image_url` | Disabled by default; hardened resolver supplied | Manual redirects, DNS/public-address validation and address pinning per hop, URL/header/time/download limits, abort propagation, credential/query redaction |
| Usage, revised prompt, moderation detail | Truthful optional mapping only | Omitted unless supplied by verified provider events; no default-zero usage/cost or fabricated moderation categories/scores |
| Codex/ChatGPT subscription generation | Fail closed in production | No permitted positive entitlement/private-wire fixture exists; no entitlement, usage, moderation, partial, or transparency capability is invented |
| Responses `image_generation` hosted tool | Not part of this child | Assigned to dependent `codex-responses-image-tool`; exported seams above are its integration boundary |
| Permissions/config/daemon/UI/persistent reference backend | Not part of this child | Assigned to dependent `codex-images-production-wiring` |
| Generic Files API, `response_format`, `input_fidelity` | Unsupported here | No generic file upload/download routes or undocumented option claims are added |
| Standalone web search, compact, Responses WebSocket, stored/background Responses | Out of portfolio scope for this change | No implementation or claim |

## Lifecycle, safety, and redaction evidence

- JSON and multipart paths enforce declared and observed byte ceilings before provider acquisition. Multipart also enforces its own header-pair ceiling because Busboy 1.6 does not expose a configurable parser limit.
- Request assets use unpredictable verified private directories, exclusive restrictive files, bounded fresh streams, request spools, idempotent cleanup, and leases retained through provider execution. Premature multipart close, parser failure, provider failure, parent abort, and client disconnect all enter cancellation/cleanup paths.
- Mask format/dimensions/real-alpha compatibility and every local/reference/remote raster are validated before provider execution. Regression tests assert zero provider starts on pre-dispatch rejection.
- Errors, response headers, SSE errors, and audit records use allow-listed coarse fields. Sentinel tests cover bearer tokens, cookies, prompts, paths, URL queries, Base64, nested causes, and raw tenant/route tokens.
- The direct production dependencies used by this surface resolve to `busboy@1.6.0`, `streamsearch@1.1.0`, `sharp@0.35.4`, and `undici@6.28.0`. `npm audit --omit=dev --json` reports no finding for those packages and zero critical findings. Two unrelated pre-existing transitive high findings remain in `form-data` and `ip-address`.

## Verification commands and results

### Focused and integration tests

```powershell
npx vitest run packages/core/src/image-generation packages/subscriptions/src/image-generation packages/core/src/openai-operation/__tests__/openAIOperation.test.ts packages/core/src/openai-operation/__tests__/openAIOperationRegistry.test.ts packages/core/src/provider-proxy/__tests__/openAIOperationDispatch.test.ts packages/core/src/provider-proxy/__tests__/ProviderProxy.lastResort500.test.ts
```

Result: 18 files considered; 17 passed and the environment-gated Python contract file skipped, with 180 tests passed and one skipped. This covers the foundation, all Images API suites, subscriptions adapter/Base64 regressions, and operation registry/dispatch.

The Python contract was then executed explicitly:

```powershell
$env:OMNICROSS_PYTHON_SDK_EXECUTABLE = Join-Path $env:LOCALAPPDATA 'Temp\omnicross-openai-sdk-3.5.0\Scripts\python.exe'
npx vitest run packages/core/src/image-generation/openai-images/__tests__/pythonSdk.contract.test.ts
```

Result: one test passed using Python 3.12.4 and official `openai==3.5.0`. Generate plus multipart ordered multi-image edit/mask both reached the real local registry/router harness and decoded byte-identical output. The child process explicitly bypasses ambient proxies for loopback and the SDK client has a bounded timeout. The JavaScript contract in the combined suite uses official `openai@7.8.0` and passed generate, edit/mask/multi-reference, transparent PNG/WebP, stream partial/completed, cancellation, and representative error cases.

### Typecheck, build, and built-export smoke

```powershell
npm run typecheck -w @omnicross/core
npm run typecheck -w @omnicross/subscriptions
npm run build -w @omnicross/core
npm run build -w @omnicross/subscriptions
```

Result: both typechecks passed. Both builds passed ESM, CJS, and DTS generation; the collected core DTS phase completed successfully. ESM and CJS import smoke checks passed for `createImageApiContributions` and `createSafeRemoteImageResolver` from both the core root and `image-generation` subpath.

### Dependency and candidate-tree gates

```powershell
npm audit --omit=dev --json
npm ls busboy sharp streamsearch undici --workspace @omnicross/core --depth=2
rasen validate codex-images-api-surface --type change --strict --json
```

Result: the target runtime dependency set is as recorded above; Rasen strict validation passed with zero issues. A temporary-index candidate tree including untracked files passed `git diff --cached --check`, strict UTF-8 decoding, BOM/U+FFFD/mojibake rejection, content-sentinel secret scanning, and the forbidden-path audit.

## Durable findings for dependent child planning

- Hosted Responses execution must consume provider partial/final events directly and retain reference leases/results; it must not round-trip through the HTTP handlers or fabricate partial events.
- The trusted route identity is `route.apiKeyId`/the injected tenant, never the bearer token. Optional `file_id` and remote URL inputs remain fail-closed unless their ports are explicitly injected.
- Handler completion is later than the client receiving `response.end()`: cleanup/audit assertions must await the server-side request-idle signal, while production cleanup remains in handler `finally`.
