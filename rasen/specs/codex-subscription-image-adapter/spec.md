# codex-subscription-image-adapter Specification

## Purpose
TBD - created by archiving change codex-image-provider-foundation. Update Purpose after archive.
## Requirements
### Requirement: Private subscription wire isolation
The Codex/ChatGPT image adapter SHALL keep its upstream URL selection, request envelope, event decoder, response decoder, private error sniffing, and protocol-version evidence inside `@omnicross/subscriptions`. It MUST implement the provider-neutral core seam and MUST NOT export private wire types from the subscriptions package.

#### Scenario: Core consumes the adapter
- **WHEN** core registers the Codex subscription image provider
- **THEN** core depends only on `ImageProvider` contracts and contains no `chatgpt.com` URL or private response-field knowledge

#### Scenario: Private schema changes
- **WHEN** a critical upstream field or terminal shape is not recognized
- **THEN** the adapter fails with `upstream_protocol_changed` and does not emit completed output

### Requirement: Existing subscription authentication and account selection
The adapter SHALL obtain Codex OAuth authentication and account selection through the existing injected subscription auth/account mechanisms. It MUST NOT accept the Omnicross inbound API key as an upstream credential, and the account selected during lease acquisition MUST remain bound to capability evidence, dispatch, unauthorized refresh, and outcome attribution for that lease.

#### Scenario: Lease acquires a Codex account
- **WHEN** the adapter acquires a provider lease
- **THEN** the existing Codex auth strategy selects an eligible account and injects its bearer credential only into private in-process transport state

#### Scenario: No valid subscription credential
- **WHEN** no eligible Codex account credential is available
- **THEN** acquisition fails as `upstream_auth_required` without making an upstream image request or exposing credential detail

### Requirement: Unverified subscription capability fails closed
The production adapter SHALL require fresh affirmative evidence for the selected account entitlement and the recognized upstream image protocol before it reports image availability or starts a job. A model name, public OpenAI documentation, a user config toggle, or successful text Responses traffic alone MUST NOT count as subscription image entitlement/protocol evidence.

#### Scenario: Text Responses works but image evidence is absent
- **WHEN** the selected Codex account can call the existing text Responses endpoint but no verified image entitlement/protocol evidence exists
- **THEN** image capabilities remain unavailable and job start fails as `unsupported_capability`

#### Scenario: Evidence is stale
- **WHEN** previously verified account or upstream evidence exceeds its configured validity window
- **THEN** the adapter treats it as unknown until a permitted verification path refreshes it

### Requirement: Verified request and response mapping
When all capability layers are verified, the adapter SHALL map normalized generate/edit options to the verified subscription wire without silently changing model, quality, size, output count, background, format, moderation, edit inputs, mask, or partial-image request. It SHALL emit only independently decodable images and MUST reject malformed, empty, mismatched-count, or invalid-Base64 output.

#### Scenario: Verified non-stream generation
- **WHEN** verified evidence permits the requested generate options and the upstream returns a recognized successful image result
- **THEN** the adapter emits accepted and completed events containing the actual binary image properties and only upstream-provided revised prompt/usage

#### Scenario: Requested feature is not evidenced
- **WHEN** the request asks for edit, mask, multiple inputs, transparency, output format, count, or partial images not affirmed by all capability layers
- **THEN** the adapter returns `unsupported_capability` before transport dispatch rather than dropping or substituting the option

### Requirement: Stable subscription failure mapping
The adapter SHALL distinguish invalid/expired subscription authentication, rate limiting, subscription usage exhaustion, moderation blocking, timeout/cancellation, transient generation failure, and private protocol drift using stable core errors. It MUST preserve `Retry-After` or a coarse reset time only when the upstream supplied a validated value and MUST NOT invent moderation categories or scores.

#### Scenario: Subscription limit is reported
- **WHEN** a verified upstream response identifies exhausted subscription image usage
- **THEN** the adapter emits `subscription_usage_limit_reached` with only validated retry timing and no cost estimate

#### Scenario: Moderation information is incomplete
- **WHEN** the upstream reports a moderation block without trustworthy categories
- **THEN** the adapter emits `moderation_blocked` and omits moderation categories/scores

### Requirement: Sensitive-body egress and diagnostics
Every image upstream call SHALL use an injected proxy-aware egress path configured to suppress request and response bodies from debug trace, audit, exception, and log capture. Diagnostics and fixtures MUST exclude bearer/refresh tokens, Cookies, full account IDs, prompts, input/output images, masks, data URLs, and Base64, retaining only field names, bounded shape metadata, enumerated options, byte counts, request-ID digests, or shape hashes.

#### Scenario: Debug trace is enabled
- **WHEN** an operator enables upstream exchange tracing during an image request
- **THEN** headers are redacted and both request and response bodies are replaced with a redacted marker while status, timing, and byte counts remain diagnosable

#### Scenario: Adapter throws on malformed output
- **WHEN** parsing fails on an upstream body containing prompt or image data
- **THEN** the thrown/mapped diagnostic contains no excerpt of that body

### Requirement: Evidence-grounded fixtures
Successful private-wire golden fixtures SHALL be committed only when derived from a real verified upstream exchange and sanitized according to the sensitive-body policy; each such fixture MUST record non-secret provenance metadata and the evidence date/version. Synthetic provider fixtures MAY test core orchestration but MUST NOT be labeled as subscription entitlement, live support, usage, moderation, transparency, or partial-image evidence.

#### Scenario: No verified capture exists
- **WHEN** implementers cannot obtain and sanitize a real successful subscription image exchange
- **THEN** the adapter ships with fail-closed and negative/protocol-drift tests only and its capability matrix records live subscription image generation as unverified

#### Scenario: Fixture passes secret scan
- **WHEN** a verified fixture is introduced
- **THEN** tests prove it contains no credential, Cookie, account ID, full prompt, image bytes, Base64, or other content secret before it can support capability evidence

