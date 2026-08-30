# Hosted Responses image integration handoff

## Exported dormant seam

`@omnicross/daemon` exports:

- `createHostedImageContributionFactory(manager)`
- `HostedImageContributionFactory`, whose `acquire()` returns a promise
- `HostedImageRuntimeGenerationLease`, containing `generationId`, the real `ResponsesImageGenerationContribution`, and idempotent async `release()`
- `Daemon.hostedImageContributionFactory`, composed once at daemon bootstrap

Factory construction performs no acquisition, provider call, traffic inspection, self-registration, or Native Responses ingress mutation. A lease pins one runtime generation across hot reload until `release()`.

## Required final-integrator order

1. Perform existing Native Responses affinity authorization before acquiring image runtime state.
2. Call `daemon.hostedImageContributionFactory.acquire()` and hold the returned generation lease.
3. Inspect and validate the real selected main-model/image plan against that pinned generation and its effective capability evidence.
4. Create exactly one request resource scope using the generation's shared reference/state truth and the final integrator's global image-call allocator.
5. Execute selected image calls through `lease.contribution`; do not construct a duplicate provider, orchestrator, evidence source, reference store, or state store.
6. Commit all image call bindings/state atomically before emitting terminal success.
7. Assemble the official Native Responses terminal event only after commit succeeds.
8. Dispose the request scope in `finally`, including input/output spools and reference/state leases.
9. Call `lease.release()` in `finally` after scope disposal. The release is idempotent, but ownership should still be singular.

## Ownership left outside this Change

| Responsibility | Owner |
| --- | --- |
| Main-model/tool selection and validation | Final Native Responses integrator |
| Existing affinity authorization | Final Native Responses ingress owner |
| Global image-call allocation across a Responses request | Final Native Responses integrator |
| Official terminal event assembly and ordering | Final Native Responses integrator |
| Ingress injection and request wiring | Final Native Responses ingress owner |
| Provider/orchestrator/reference/state/evidence generation pinning | Daemon factory and returned lease |
| Per-call execution and image-state commit contract | Returned `ResponsesImageGenerationContribution` |

The later integrator must not treat factory availability as production capability. Missing/stale/mismatched selected-account evidence remains fail-closed, and the current child intentionally does not modify `openaiResponsesIngress.ts`, Responses profile/affinity/core, or `providerProxyShared.ts`.
