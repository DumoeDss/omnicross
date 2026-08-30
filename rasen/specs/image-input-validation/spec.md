# image-input-validation Specification

## Purpose
TBD - created by archiving change codex-images-api-surface. Update Purpose after archive.
## Requirements
### Requirement: Bounded request-body ingestion
Images handlers SHALL own their request bodies and MUST enforce declared and observed limits while streaming. JSON decoding MUST use strict UTF-8 with a bounded scalar/body budget; multipart parsing MUST bound total bytes, per-file bytes, files, fields, parts, header pairs, field names, and field values, and MUST abort parsing as soon as any bound is exceeded.

#### Scenario: Oversized declared body is rejected early
- **WHEN** `Content-Length` is invalid or greater than the configured Images body limit
- **THEN** the handler returns `image_too_large` without consuming the body or starting an image job

#### Scenario: Chunked request exceeds the observed limit
- **WHEN** a JSON or multipart body has no usable declared length and crosses the configured observed limit
- **THEN** body consumption is cancelled, partial temporary resources are removed, and the request returns `image_too_large`

#### Scenario: Multipart limits stop parser abuse
- **WHEN** multipart exceeds any configured file, field, part, header, or aggregate bound
- **THEN** parsing stops with a stable local error and no truncated part is accepted as an `ImageAsset`

### Requirement: Signature and complete pixel-decode validation
Every newly ingested image or mask SHALL derive its format from content signature rather than filename or declared content type and MUST complete a real bounded raster decode before being marked independently decodable. The decoder MUST reject truncated/corrupt containers, unsupported formats, zero or excessive dimensions, excessive total pixels, excessive decoded raw bytes, frame/page counts outside policy, and decompression bombs before orchestrator dispatch.

#### Scenario: Declared MIME disagrees with bytes
- **WHEN** a multipart part claims PNG but contains JPEG, WebP, text, or corrupt bytes
- **THEN** the trusted asset MIME comes only from a supported decoded signature or the input is rejected as `unsupported_image_type`

#### Scenario: Header-only image is not accepted
- **WHEN** an input has a plausible signature and dimensions but its pixel payload is truncated or corrupt
- **THEN** complete decode fails and the image job start count remains zero

#### Scenario: Pixel bomb is rejected within budget
- **WHEN** a compact input expands beyond the configured pixel or raw-byte budget
- **THEN** the decoder terminates with `image_too_large` without an unbounded allocation

### Requirement: Mask compatibility and alpha semantics
A mask SHALL be validated separately and MUST have the same decoded format, width, and height as the primary edit image and contain a real alpha channel. Validation MUST complete before provider acquisition or job start; alpha, dimensions, or format MUST NOT be inferred from filenames or request fields.

#### Scenario: Valid mask accompanies primary image
- **WHEN** the mask fully decodes with the same format and dimensions as the first edit image and has alpha
- **THEN** the normalized edit keeps that validated mask distinct from the ordered reference-image list

#### Scenario: Mask mismatch is rejected locally
- **WHEN** the mask lacks alpha or its decoded format or dimensions differ from the primary image
- **THEN** the handler returns `invalid_image_request` naming `mask` and upstream start count remains zero

### Requirement: Controlled temporary asset lifecycle
Multipart, data URL, and downloaded input content SHALL be written only beneath a configured or OS-controlled temporary root using unpredictable per-request directories, exclusive files, restrictive permissions, and no workspace-relative path. File paths MUST remain private implementation state, every `open()` MUST produce an independently bounded stream, and all temporary resources MUST be removed after completion, failure, parse rejection, or cancellation.

#### Scenario: Successful edit cleans temporary files
- **WHEN** a multipart edit reaches a completed provider event
- **THEN** its temporary files remain available only through the orchestrator lifetime and are removed after all readers and leases release

#### Scenario: Aborted upload cleans partial files
- **WHEN** the client disconnects while a multipart file is being streamed
- **THEN** open writers are closed, the incomplete asset is never dispatched, and the per-request temporary directory is removed

#### Scenario: Workspace path is never used
- **WHEN** the process runs from a Git worktree
- **THEN** temporary image bytes are created outside that worktree and no content-derived or caller-controlled filename determines their path

### Requirement: Tenant-scoped file and image-reference resolution
JSON `file_id` SHALL resolve only through an injected minimal image-asset/reference port using the trusted tenant ID. Missing or cross-tenant references MUST be indistinguishable as `image_reference_not_found`, owning-tenant expiry MUST return `image_reference_expired`, leases MUST pin active assets, and absence of the resolver MUST make `file_id` unsupported without creating a generic Files API.

#### Scenario: Active reference is leased
- **WHEN** the owning tenant supplies an unexpired image reference
- **THEN** the handler uses its leased validated asset and releases the lease after the image job terminates

#### Scenario: Cross-tenant lookup is hidden
- **WHEN** another tenant supplies an existing reference ID
- **THEN** the response is `image_reference_not_found` and discloses no metadata or existence signal

### Requirement: Remote image URL SSRF boundary
Remote HTTP(S) image loading SHALL be disabled unless an injected policy explicitly enables it. An enabled resolver MUST reject credentials in URLs and all non-HTTP(S), loopback, private, link-local, multicast, unspecified, and metadata destinations; resolve and pin an approved address for each hop; revalidate every redirect; cap redirects, connect/total time, headers, and downloaded bytes; and pass the result through the same real image validator. Data URLs MUST use a separate bounded decoder and MUST NOT enter network resolution.

#### Scenario: Remote loading is not wired
- **WHEN** a JSON edit supplies an HTTP(S) `image_url` and no enabled resolver exists
- **THEN** the request returns `unsupported_capability` without issuing DNS or network traffic

#### Scenario: Redirect crosses into private space
- **WHEN** an initially public URL redirects to loopback, RFC1918, link-local, metadata, or another disallowed address
- **THEN** the resolver rejects the redirect before connecting to the new destination

#### Scenario: DNS rebinding cannot change the connected address
- **WHEN** a hostname resolves to an approved public address and later DNS answers change
- **THEN** the request connects only to the address approved for that hop or fails closed

### Requirement: Content-bearing data is structurally excluded from audit
Request parsing, validation, error mapping, and cleanup SHALL expose only bounded metadata to ordinary telemetry and audit interfaces. Prompt text, multipart content, data URLs, remote URL credentials/query content, file paths, masks, raw images, Base64, Cookies, bearer tokens, opaque provider references, and unkeyed low-entropy hashes MUST NOT appear in logs, snapshots, exception messages, or diagnostic bundles.

#### Scenario: Secret sentinel failure remains redacted
- **WHEN** parsing or decoding fails on inputs containing token, Cookie, prompt, URL-query, path, and Base64 sentinels
- **THEN** captured logs, errors, snapshots, and response bodies contain none of those sentinels

#### Scenario: Validation telemetry is metadata-only
- **WHEN** a valid multi-image edit reaches the orchestrator
- **THEN** telemetry can report counts, byte totals, decoded dimensions, format, timing, and stable code but has no field capable of carrying the original content

### Requirement: Stack-safe bounded subscription Base64 decoding
Before public Images routes can expose subscription results, the private-wire Base64 decoder SHALL derive decoded length from encoded length and padding, reject zero or over-50-MiB decoded candidates before full validation or allocation, and validate the alphabet/padding with a stack-safe linear procedure. Malformed, exact-boundary-invalid, and over-limit values MUST consistently become `upstream_protocol_changed`, never a raw `RangeError` or process failure.

#### Scenario: Limit-plus-one is rejected before decode
- **WHEN** a syntactically plausible Base64 candidate declares a decoded size one byte above the configured 50-MiB ceiling
- **THEN** the adapter returns `upstream_protocol_changed` without calling `Buffer.from`, image decode, or a stack-sensitive full-string regular expression

#### Scenario: Exact limit remains stack-safe
- **WHEN** a candidate encodes exactly the maximum allowed decoded size
- **THEN** alphabet and padding validation completes without stack overflow and subsequent format/decode failure, if any, is normalized as `upstream_protocol_changed`

