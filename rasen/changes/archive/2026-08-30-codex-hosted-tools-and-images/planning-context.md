# Planning context: codex-hosted-tools-and-images

## User intent (verbatim)

> 请在现成 worktree `E:\AI\ChatAI\Agents\VibeCodingProjects\elftia\elftia\omnicross--codex-hosted-tools-and-images` 继续开发 Omnicross 的完整生图能力。当前分支应为 `feat/codex-hosted-tools-and-images`，起始基线应为 `eb2d20a8278870f36af2996914b831f7b8446484`；不要重新创建 worktree 或分支。
>
> 首先完整阅读 `docs/design/omnicross-image-generation-requirements.md`。其中“Session B 执行契约”是本 Change 的最高优先级边界。创建并推进 Rasen Change `codex-hosted-tools-and-images`，完成实现、验证、review cycle，最后 push 并向 `main` 提 PR，但不要自行合并。
>
> 以真实代码和可验证的上游能力为准，不伪造订阅 entitlement、usage、审核结果或私有协议。完成相关测试、typecheck、build、安全/UTF-8/diff 检查，并在 PR 中明确能力矩阵、未支持项和最终集成接口。

## Verified starting facts

- Worktree and branch were pre-existing; neither was recreated.
- `HEAD`, `origin/main`, and the requested baseline all resolve to `eb2d20a8278870f36af2996914b831f7b8446484` after `git fetch origin main` on 2026-08-29.
- The worktree was clean before Rasen artifacts were created.
- `docs/design/omnicross-image-generation-requirements.md` is strict UTF-8 without BOM or replacement characters and was read in full, including Session B.
- The concurrent Core session owns Native Responses core/profile work.

## Hard ownership boundaries

- Never modify `packages/core/src/openai-operation/**`.
- Never modify `openaiResponsesIngress.ts` or `providerProxyShared.ts`.
- Export `images.generate` and `images.edit` registry contributions.
- Export a self-contained hosted `image_generation` execution contribution for a final integrator to inject into Responses ingress.
- Do not implement standalone web search, compact, Responses WebSocket, generic Files API, or stored/background Responses.
- Private ChatGPT/Codex wire shapes stay inside subscriptions. Unknown/unverified capabilities fail closed and are not advertised.
- Do not fabricate entitlement, usage, moderation outcomes, partial images, transparent output, cost, or protocol stability.

## Decomposition and dependency rationale

The parent is a planning container. Children are deliberately serialized because they share image-domain contracts and host wiring; absence of an explicit edge would not prove file-level independence.

1. `codex-image-provider-foundation`: stable contracts, orchestrator, capability/error/usage/cancellation, references, isolated subscription adapter.
2. `codex-images-api-surface`: depends on foundation; Image API handlers/contributions, validation, multipart/JSON, edits/mask/multi-reference, SSE.
3. `codex-responses-image-tool`: depends on Image API slice as a conservative serialization edge; hosted contribution, output/partial mapping, multi-turn references.
4. `codex-images-production-wiring`: depends on all prior work; permissions/config/router/daemon/UI, capability/model/doctor exposure, resource and audit hardening, complete verification.

Each child uses `small-feature` and ships locally only. The parent performs the single push and PR after every child is review-clean.

## Durable planning constraints

- Core and both external protocol faces share one ImageProvider/ImageOrchestrator and one artifact/reference lifetime model.
- Capability is an explicit intersection of adapter declaration, account evidence, and observed upstream response. Unknown means unsupported.
- `usage` is omitted when unavailable; Base64/prompt/token/cookie/account identifiers are never logged or snapshotted.
- Images permission is independent from Responses permission.
- JSON and multipart parsing must be bounded before upstream dispatch; URL references require SSRF and redirect revalidation.
- Non-stream Responses success stores final Base64 in `image_generation_call.result`; partial events use `response.image_generation_call.partial_image`.
- The PR must distinguish protocol/test support from live subscription entitlement and Codex host `$imagegen` availability.

## Mid-run main integration sync

- At the user's request, the run fetched and merged `origin/main` after it advanced to `7f14b7c52477ab7cc7f136db3589946216fba922` (merged PR #28 Codex Responses core profile and PR #29 Claude API gateway).
- The integration merge commit is `0b38f35caa1c04225366b61854eb22eda3f8eb99`; merge-base with `origin/main` is exactly `7f14b7c`.
- Images API WIP was quiesced into a durable implementer handoff, stashed under object `522e3ea0277ec927cb713fb20764ec843369ccb6`, and cleanly re-applied after the merge with zero unmerged paths. The stash remains as a temporary recovery point until the WIP is locally committed.
- `openaiResponsesIngress.ts` and `providerProxyShared.ts` changed only through the upstream `main` merge. This Change must not author follow-up edits in either file.
- During Images API verification, `origin/main` advanced again to `83a3cfbad9d2b4f2ee8ac3b4aa594c2617b39594` with two disjoint overview UI files. It was merged without conflict as `a468f3ccfcf1575b254d34400d006d6f73b0584e` before the fix round.

## Foundation proposal discoveries

- The repository verifies Codex subscription authentication/account selection and the text Responses endpoint `https://chatgpt.com/backend-api/codex/responses`, but contains no sanitized successful subscription image exchange and no account-level image entitlement evidence. Text Responses success, public documentation, model names, and config toggles therefore cannot enable image capability; the production image adapter must remain fail-closed until fresh account and observed-protocol evidence exist.
- Existing `fetchUpstream` is the required proxy-aware egress seam, but its opt-in upstream trace captures relay request/response bodies verbatim unless `redactBodies: true`. Every image transport call must force body redaction because prompts, masks, input/output images, data URLs, and Base64 are sensitive.
- The provider seam will use an account-bound short-lived lease (`acquire` -> resolved capabilities + `start` -> `release`) so pooled account selection cannot change between capability validation and dispatch. Later Images API, hosted Responses, and production wiring Changes consume this seam and the shared tenant-safe artifact/reference ports.

## Images API surface proposal discoveries

- Extension handlers are dispatched before the shared router reads a body, so `images.generate` and `images.edit` contributions must own strict bounded JSON/multipart ingestion. A safe contribution is a non-self-registering `{ operationId, handler }` value/factory; final app-session composition remains the only registry mutator.
- The existing subscription response validator already uses Sharp for a forced complete pixel decode, while core has no multipart or raster dependency. The API surface design reuses the same locked Sharp version in core and adds Busboy for bounded streaming parts; signature/header-only validation is insufficient for any asset marked independently decodable.
- `route.apiKeyId` is the available trusted outbound-key tenant identity. Images handlers must use an injected tenant/runtime resolver and reject missing identity rather than hash the raw bearer; `user` is retained only through an injected keyed irreversible fingerprint.
- Remote `image_url` cannot be made SSRF-safe with a one-time hostname check plus ordinary redirect-following fetch. It stays disabled unless an injected resolver proves per-hop address validation/pinning, redirect revalidation, byte/time bounds, and common raster validation; `file_id` similarly stays unsupported unless the minimal tenant-scoped image reference port resolves it.
- Non-stream output needs bounded Base64 spooling before committing HTTP 200 to avoid both `n=10` heap multiplication and late asset-read success lies. SSE instead encodes one complete artifact at a time, waits for drain/abort before pulling another event, and never repeats a final image as a fabricated partial.
- Before either public contribution is exposed, `privateWireResponse.decodeStrictBase64()` must calculate decoded length from padding and reject over-50-MiB candidates before a manual linear alphabet scan/`Buffer.from`; the current large anchored regex can surface a raw stack-overflow `RangeError`.

## Responses hosted image proposal discoveries

- The landed Native Responses ingress is a single upstream relay with credential/session affinity but no hosted-execution seam. The final integrator must mediate the main-model terminal response, supply the actual selected image-call plans, and share one global output-index/sequence allocator; the hosted contribution cannot truthfully infer automatic selection or self-register.
- Existing `ResponsesAffinityStore` remains the authorization boundary for `previous_response_id` and main-model credential routing, while image call/response mappings require a separate tenant-scoped state index over `ImageReferenceStore`. The integrator must authorize affinity first; the image request scope then holds both state and artifact leases through execution and atomically commits or rolls back new call bindings.
- Hosted execution can reuse `ImageOrchestrator` retention and stable events directly. A per-Response request scope is the durable lifecycle seam: it serializes selected calls, counts all partial/final bytes against one budget, maps real partials only, commits inherited/new image context before terminal success, and deletes uncommitted retained outputs on failure or cancellation.

## Responses hosted image durable implementation findings

- The linked request signal is created before all persistent image-state/reference lookups and is transferred to the request scope only after the final abort check.
- Any production state/reference implementation may resolve after cancellation, but a returned lease must still be surfaced normally: the contribution records it first, then cancellation cleanup releases it deterministically.
- Final integration must dispose every successfully created scope in `finally`; that disposal owns the long-lived runtime abort listener after construction succeeds.
- Production state storage must preserve the tenant-scoped known-empty response marker; missing, cross-tenant, expired, and capacity-evicted image state are distinct outcomes.
- Hosted terminal image records stay internal; the final ingress integrator owns official terminal event construction and the shared global output-index/sequence allocator.

## Production wiring proposal discoveries

- The Codex image provider must receive its `AuthStrategy` from `subscriptionAccounts.getStrategy('codex')`; the dispatch-profile `SubscriptionProviderRegistry` consumes those strategies internally but does not expose them. Bootstrap must also create and inject the `OpenAIOperationRegistry` before its current first `getProviderProxy(...)` call.
- The current admin `PUT /server` persists settings before applying live side effects, while `OutboundApiServer.applyConfig` mutates its snapshots before a potentially failing listener restart. Images updates therefore need an explicit prepare → atomic persist → infallible publish transaction with restoration of both the prior document and published snapshots on an unexpected commit failure.
- General audit capture currently wraps responses before authentication, and `ImageRequestResourceScope` defaults to the OS temp root with only per-request accounting. Production Images must classify early enough to suppress body wrapping and inject a daemon-private temporary root plus shared active-scope/per-tenant/total-byte budgets and owned-marker startup cleanup.

## Production wiring durable implementation findings

- The app-session storage catalog is constructed even while Images is default-disabled so restart references, retired mounts, and the first proxy's registry dependency stay coherent. Its application-data parent is therefore a daemon boot boundary: tests and embedders must place `configPath` under a private sibling root, never a root broad enough to contain the user home, OS temp root, workspace, worktree, or a symlink component.
- Native Responses affinity already rejects a fabricated `previous_response_id` even when stable session/thread headers select the same conversation. Regression fixtures and the final image integrator must propagate the actual returned response ID; session affinity is not authorization to invent a continuation ID.
- A live fixed-port bind-address change cannot be prepared failure-atomically because the replacement socket cannot coexist with the current listener on every supported platform. The transaction rejects that update before persistence; operators must disable first or change the port, while same-bind snapshot updates remain hot and atomic.
