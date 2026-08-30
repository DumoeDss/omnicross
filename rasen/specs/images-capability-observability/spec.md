# images-capability-observability Specification

## Purpose
TBD - created by archiving change codex-images-production-wiring. Update Purpose after archive.
## Requirements
### Requirement: Effective capability is fresh evidence intersection
The production capability resolver SHALL expose only the intersection of the shipped adapter declaration, evidence for the selected account, and strictly observed upstream protocol evidence, each valid at the evaluation time. Missing, stale, failed, mismatched-account, or mismatched-model evidence MUST resolve unavailable. Configuration, a model name, public documentation, text Responses success, a synthetic provider, or one capability layer alone MUST NOT create production availability.

#### Scenario: Configuration is enabled without evidence
- **WHEN** Images is enabled for `gpt-image-2` but account or upstream evidence is unknown
- **THEN** effective generation, edit, and hosted Responses capabilities remain unavailable with a safe reason

#### Scenario: Narrow generation evidence is fresh
- **WHEN** the adapter, selected account, and observed response affirm one non-stream PNG generation with `n=1`
- **THEN** only that exact supported intersection is available and edit, masks, partials, transparency, Responses-tool, usage, moderation, cost, and other formats remain unsupported or unknown

#### Scenario: Evidence expires during a runtime generation
- **WHEN** the evidence TTL elapses before a later acquisition
- **THEN** that acquisition fails closed without an automatic consuming probe even though prior requests used the same configured generation

### Requirement: Capability evidence is narrow, private, and account-bound
Persistent capability evidence SHALL use a versioned allow-list containing only the tested provider/model/options, observed safe response-field flags, source version, verified time, and expiry. It SHALL be keyed by a domain-separated HMAC of the selected account identity and MUST NOT contain credentials, Cookies, raw account IDs, request/response bodies, prompts, image bytes, Base64, provider references, or unverified feature claims.

#### Scenario: Account selection changes
- **WHEN** a pooled request selects an account different from the one with fresh positive evidence
- **THEN** the positive row is not reused and the newly selected account remains unavailable until independently verified

#### Scenario: Evidence file is inspected
- **WHEN** secret-sentinel verification scans serialized evidence
- **THEN** it finds only allow-listed metadata and none of the bearer, Cookie, account, prompt, image, Base64, URL, or private-wire canaries

### Requirement: Model listing is conditional and protocol-truthful
`GET /v1/models` SHALL include `gpt-image-2` only when the authenticated key explicitly has the Images permission, Images configuration is enabled, and fresh effective evidence affirms the configured provider/model. A legacy absent permission list, Responses-only permission, disabled config, stale evidence, or unavailable capability MUST omit the image model. Auto shape SHALL use OpenAI format when a key explicitly includes Images, even if it also includes Messages; a forced Anthropic shape SHALL omit the image model rather than emit an invalid Anthropic model entry.

#### Scenario: Images-authorized key has fresh capability
- **WHEN** an explicitly Images-authorized key lists models under auto shape with fresh effective `gpt-image-2` evidence
- **THEN** it receives the OpenAI model-list shape containing one deduplicated image model alongside only its authorized text models

#### Scenario: Responses permission only
- **WHEN** a key authorized for Responses but not Images lists models
- **THEN** `gpt-image-2` is absent even if another key or account has fresh image evidence

#### Scenario: Anthropic shape is forced
- **WHEN** configuration forces Anthropic model-list shape for a key that also has Images permission
- **THEN** the response remains valid Anthropic discovery and omits `gpt-image-2`

### Requirement: Authenticated capability and runtime status are non-consuming
The daemon SHALL expose authenticated, secret-free Images capability and runtime status through admin dependencies injected from the live runtime manager. Reads SHALL report configured versus effective state, safe unavailable reason, evidence age/expiry, affirmed feature/limit matrix, generation ID, endpoint URLs, queue active/waiting counts, and aggregate temporary/store utilization. Admin status, UI polling, outbound status, and model listing MUST NOT dispatch an image, refresh evidence through generation, decrypt an image, or expose storage paths, evidence blobs, prompts, hashes, raw tenant/account IDs, or private provider fields.

#### Scenario: UI polls unavailable Images status
- **WHEN** the API Service page polls status while evidence is missing
- **THEN** no upstream image request occurs and the UI distinguishes configured enablement from effective unavailability

#### Scenario: Existing status clients read the upgraded daemon
- **WHEN** Images status fields are added
- **THEN** the existing four text endpoint/status shapes retain their meanings and Images appears only in additive optional fields

#### Scenario: Runtime status is read during hot reload
- **WHEN** old work is draining after a new generation is published
- **THEN** status reports the active generation and bounded draining counts without exposing request or account identities

### Requirement: Doctor is non-consuming by default and explicit when live
`omnicross doctor images` SHALL perform only local configuration, permission schema, root safety, store integrity, account-presence, and cached-evidence checks. Only `omnicross doctor images --live` MAY consume subscription quota; before dispatch it MUST print an explicit warning, require Images enabled plus an eligible Codex account, issue at most one minimal low-quality PNG generation, force body tracing redacted, strictly validate the artifact, destroy it, and report exactly what was observed.

#### Scenario: Default Images doctor runs
- **WHEN** an operator runs `doctor images` without `--live`
- **THEN** it performs zero image generation requests and reports unknown/stale live capability honestly

#### Scenario: Live doctor succeeds narrowly
- **WHEN** the operator accepts the warning and one real generation succeeds with a strictly valid PNG
- **THEN** the doctor may persist expiring evidence only for the exact account/model/options and observed fields and does not infer any untested feature

#### Scenario: Live doctor fails
- **WHEN** auth, entitlement, moderation, rate limit, timeout, protocol, decoding, or cleanup fails
- **THEN** no positive evidence is persisted, the diagnostic uses a stable safe reason, and no response body or image remains in logs or temporary storage

### Requirement: General audit body capture is structurally disabled for Images
The outbound audit path SHALL classify Images before installing content capture. For Images requests it MAY record metadata such as key ID, method, normalized path, status, duration, safe provider/model, and stable error code, but MUST NOT wrap response writes for body capture or stash request bodies even when global audit `captureBodies` is enabled. Images-specific audit, telemetry, errors, logs, snapshots, diagnostics, and admin views MUST accept only allow-listed metadata.

#### Scenario: Global body capture is enabled
- **WHEN** an Images JSON, multipart, non-stream Base64, or SSE response passes through the outbound listener
- **THEN** general audit stores no request or response body and never copies image content into its capture buffers

#### Scenario: Unauthorized Images request is audited
- **WHEN** authentication or Images permission fails before body consumption
- **THEN** metadata-only status/path timing may be recorded without wrapping the response body or reading the upload

#### Scenario: Sentinel-rich failure occurs
- **WHEN** credentials, prompt, URL query, filename, mask, Base64, raw account ID, path, and provider-reference canaries appear in a failing request or fake upstream
- **THEN** serialized audit, telemetry, errors, logs, snapshots, status, and diagnostics contain none of those values

### Requirement: Image metrics are bounded and low-cardinality
Production observability SHALL publish bounded counters and latency/byte histograms for request terminal, endpoint, safe provider/model/action/options, queue wait, generation duration, input/output counts and bytes, stable error code, reference outcome, cleanup outcome, and retry/auth-refresh count only when actually known. Labels MUST be allow-listed and bounded; raw request, tenant, account, reference, prompt, URL, path, image hash, and provider-wire values MUST NOT become labels or event fields. Unknown usage, cost, moderation, or retry data MUST be omitted rather than zero-filled.

#### Scenario: High-cardinality identifiers differ
- **WHEN** many tenants, accounts, request IDs, references, prompts, and URLs produce the same safe operation outcome
- **THEN** they aggregate into the same bounded metric dimensions and no identifier-derived label is created

#### Scenario: Provider omits usage
- **WHEN** generation succeeds without verified usage or cost fields
- **THEN** success and byte/latency metrics are recorded while usage and cost remain absent

### Requirement: Deterministic daemon and SDK evidence is labeled Tier A
Verification SHALL boot the real daemon composition with an explicitly synthetic verified image provider seam and exercise current supported JavaScript and pinned Python OpenAI SDKs against `/v1/images/generations` and `/v1/images/edits`, including multipart, cancellation, errors, and cleanup. This evidence MAY establish local authorization, routing, protocol, persistence, and lifecycle behavior, but MUST be labeled Tier A and MUST NOT establish Codex subscription entitlement or private-wire stability.

#### Scenario: SDK generation and edit pass locally
- **WHEN** both SDKs use an Images-authorized key against a booted daemon with the synthetic verified provider
- **THEN** their responses parse correctly, inputs/outputs match the harness, resources are cleaned, and the report says only local protocol support was proven

#### Scenario: Text regression suite runs beside Images
- **WHEN** the daemon-wired image suites complete
- **THEN** Chat, Responses, Messages, Gemini, model listing, audit, billing, key policy, integration-key, bootstrap/reset, and forbidden ownership regressions remain green

### Requirement: Consuming subscription and Codex host gates remain optional and honest
Verification SHALL treat a successful explicit live doctor as Tier B evidence and a current Codex custom-provider `$imagegen` host run in an isolated temporary home/config as Tier C evidence. Neither gate may run without explicit prerequisites. The Codex gate MUST use the supported host tool path, MUST NOT substitute a shell/script image generator, and MUST report unsupported when the host lacks `$imagegen`, effective hosted capability is unavailable, or final Responses ingress integration is absent.

#### Scenario: No live credentials or host prerequisites are provided
- **WHEN** normal CI and review run without opt-in live inputs
- **THEN** Tier A can pass while Tier B and Tier C are recorded as not run/unverified rather than failed or fabricated

#### Scenario: Current Codex host cannot complete the tool path
- **WHEN** the isolated host gate finds no `$imagegen` tool or no final ingress injection
- **THEN** the capability matrix records Codex host image generation as unsupported and does not invoke a fallback script

### Requirement: PR-ready capability and handoff matrix
Apply and verification evidence SHALL include a versioned matrix separating Images generate/edit protocol support, production Codex effective support, partials, transparency, moderation, usage/cost, multi-turn references, hosted Responses factory availability, final Responses ingress injection, Tier B live evidence, and Tier C Codex host support. It SHALL also document the acquire/authorize/select/scope/execute/commit/terminal/dispose/release order required by the final integrator and identify every unsupported or unverified row explicitly.

#### Scenario: Production provider remains fail-closed
- **WHEN** the Change is otherwise review-clean but no permitted live exchange has established capability
- **THEN** delivery may report the wiring complete while all affected production/live matrix rows remain unavailable or unverified and Images stays default-disabled

#### Scenario: Hosted factory is handed off
- **WHEN** the final evidence is prepared
- **THEN** it names the public factory and lease contract, states that this Change performs no ingress injection, and assigns selection, shared allocator, affinity authorization, and official terminal assembly to the later integrator

