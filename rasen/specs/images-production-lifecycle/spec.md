# images-production-lifecycle Specification

## Purpose
TBD - created by archiving change codex-images-production-wiring. Update Purpose after archive.
## Requirements
### Requirement: Selected-account fair image scheduling
The Codex subscription image adapter SHALL expose an optional execution-scheduler hook that is invoked only after authentication has selected and bound an account and before any image transport starts. The production scheduler SHALL enforce a configurable active-job limit per selected account, one bounded global waiting population, and round-robin service among tenants waiting for the same account. Its inputs MUST contain only trusted tenant identity, an opaque account scheduling key, the pinned runtime generation, and cancellation; credentials, prompts, image content, and raw account IDs MUST NOT enter scheduler state or public status.

#### Scenario: Two tenants share one selected account
- **WHEN** tenants A and B have queued jobs for the same saturated Codex account
- **THEN** released slots rotate between eligible tenant queues instead of allowing one tenant to drain all of its waiting jobs first

#### Scenario: Different accounts execute independently
- **WHEN** account A is at its active limit and an eligible request selects account B
- **THEN** account B can start without waiting for account A while the global queue bound remains enforced

#### Scenario: Queue is full
- **WHEN** a request would exceed the configured global waiting-job bound
- **THEN** it fails with `image_queue_full` before transport and no existing waiter is displaced

### Requirement: Separate queue and generation deadlines
Queue waiting and provider execution SHALL use independent positive deadlines from the request's pinned runtime generation. Queue timeout MUST start at scheduler admission and end at slot grant; generation timeout MUST start only after grant and MUST cover transport, strict response reading/decoding, and provider terminal production. Queue capacity and wait expiry SHALL use the stable `image_queue_full` and `image_queue_timeout` codes, distinct from `image_generation_timeout`; none may be reported as provider acceptance if no upstream call began.

#### Scenario: Queue deadline expires first
- **WHEN** a waiter does not receive an account slot before `queueTimeoutMs`
- **THEN** it is removed from all queues, returns `image_queue_timeout`, and makes no image upstream request

#### Scenario: Generation deadline expires after grant
- **WHEN** transport or strict output processing exceeds `generationTimeoutMs` after a slot is granted
- **THEN** the provider request is aborted, the result is `image_generation_timeout`, and the slot is released exactly once

#### Scenario: Runtime reload changes deadlines
- **WHEN** a request is queued under generation N and generation N+1 changes either timeout
- **THEN** the request retains generation N's two deadlines while later admissions use generation N+1

### Requirement: Cancellation and lease release are terminal-safe
Parent disconnect, explicit cancellation, timeout, iterator return, handler failure, hot reload retirement, and daemon shutdown SHALL propagate through one linked cancellation path. Every scheduler grant, provider lease, reference lease, state lease, resource scope, response spool, and runtime-generation lease MUST release exactly once on every terminal path. No image asset may be pulled, encoded, retained, or published after cancellation is observed.

#### Scenario: Client disconnects while queued
- **WHEN** the HTTP client disconnects before a scheduler grant
- **THEN** its waiter is removed immediately, it never consumes a later slot, and no provider is called

#### Scenario: Consumer stops an event iterator
- **WHEN** an Images or hosted Responses consumer returns early from provider events
- **THEN** the job is cancelled and all account, runtime, scope, and artifact leases are eventually released once

#### Scenario: Cancellation races a late state lease
- **WHEN** a state/reference lookup resolves with a lease after the linked signal was cancelled
- **THEN** the lease is first brought under scope ownership and then released during deterministic cleanup

### Requirement: Bounded daemon-owned temporary resources
Production Images handlers SHALL inject a daemon-owned temporary root and a shared resource-budget port into every `ImageRequestResourceScope`. The budget SHALL cap active scopes, total temporary bytes, and per-tenant temporary bytes in addition to the existing per-request API limits. Reservations MUST occur before each write, roll back on failed writes, and release on spool disposal or scope cleanup. Paths MUST use unpredictable request directories and exclusive restrictive files beneath a verified private root outside worktrees; caller filenames and content-derived names MUST never select a path.

#### Scenario: Concurrent edits reach the global temporary ceiling
- **WHEN** individually valid edit uploads would together exceed the global or tenant temporary-byte limit
- **THEN** the later reservation fails before writing beyond the ceiling and its partial scope is cleaned without affecting other requests

#### Scenario: Queueing occurs after input parsing
- **WHEN** many authorized edit requests are parsed before their subscription accounts are selected
- **THEN** the shared ingress budget still bounds their combined temporary files independently of the selected-account generation queue

#### Scenario: Request completes or fails
- **WHEN** JSON/multipart parsing, generation, output encoding, cancellation, or response writing reaches any terminal path
- **THEN** all request-owned input and spool files are closed and removed and their shared-budget reservations return to zero

### Requirement: Atomic tenant-scoped image reference persistence
The production `ImageReferenceStore` SHALL persist retained artifacts and metadata with unpredictable IDs, a versioned schema, exclusive restrictive files, and temp-write/fsync/atomic-rename publication. Tenant identities SHALL be transformed with a persistent domain-separated local HMAC before persistence. The store MUST enforce per-artifact, per-tenant bytes, total bytes, and entry-count limits before publication, MUST keep active leases non-evictable, and MUST return only the contract's not-found, expired, or capacity outcomes without exposing paths, tenant keys, or opaque provider references.

#### Scenario: Artifact publication crashes before commit
- **WHEN** the daemon exits after writing temporary bytes but before the manifest transaction commits
- **THEN** restart reconciliation never serves the incomplete artifact and removes or quarantines only the verified transaction debris

#### Scenario: Another tenant resolves a reference
- **WHEN** tenant B presents a valid unexpired reference owned by tenant A
- **THEN** the lookup is indistinguishable from not found and does not disclose owner, existence, expiry, or storage metadata

#### Scenario: Capacity cleanup encounters a lease
- **WHEN** capacity pressure selects an otherwise evictable artifact whose lease is active
- **THEN** that artifact remains readable to its holder and cleanup chooses another eligible value or returns capacity exhaustion

#### Scenario: Provider reference is retained
- **WHEN** a provider supplies an opaque reference that is necessary for later execution
- **THEN** it is persisted only through the existing host secret-box protection and never appears in manifests, logs, metrics, or admin output as plaintext

### Requirement: Persistent Responses image state preserves contract semantics
The production `ResponsesImageStateStore` SHALL preserve the implemented in-memory contract across restart: atomic multi-call commits, ordered call bindings, explicit known-empty response markers, exact idempotency, tenant isolation, owner-visible expiry, capacity eviction, tombstones, and lease pinning. It SHALL persist only bounded state metadata and reference links, never final Base64, prompts, credentials, raw tenant/account IDs, or official terminal Responses events.

#### Scenario: Known-empty response is restored
- **WHEN** a response committed with no image calls is loaded after daemon restart
- **THEN** it remains a known response with an empty ordered binding list rather than becoming missing

#### Scenario: Multi-call commit fails partway
- **WHEN** durable publication of one response's call bindings cannot complete
- **THEN** none of that response's new bindings or marker becomes visible and any newly retained uncommitted artifacts are eligible for rollback cleanup

#### Scenario: State cleanup returns call bindings
- **WHEN** response state expires or is capacity-evicted
- **THEN** cleanup returns the removed call/reference bindings to the coordinator for best-effort artifact deletion without changing missing-versus-expired semantics

### Requirement: Bounded startup recovery and recurring cleanup
Before Images serving is published, the daemon SHALL restore and strictly validate the storage-mount manifest, evidence metadata, reference index, Responses state, and owned temporary markers without following symlinks. Recovery SHALL reconcile incomplete transactions, recompute bounded counters from verified entries, preserve valid leases only as unleased restart state, and complete a bounded startup cleanup. An unref'ed recurring coordinator SHALL later remove expired unleased state/artifacts, stale owned temporary directories, bounded tombstones, and empty retired mounts in dependency order.

#### Scenario: Corrupt metadata is found at startup
- **WHEN** a manifest or entry has an unknown schema, invalid descendant path, inconsistent size, or broken reference link
- **THEN** it is never served, valid unrelated entries remain available, and recovery reports only safe counts and reason codes

#### Scenario: Foreign temporary directory shares the parent root
- **WHEN** startup cleanup encounters a directory without the exact owner marker and verified Images schema
- **THEN** it leaves that directory untouched even if its name resembles an Images prefix

#### Scenario: Expired response owns retained artifacts
- **WHEN** recurring cleanup removes expired response state and receives its call bindings
- **THEN** it requests reference deletion, skips actively leased artifacts, bounds each pass, and resumes remaining work on a later pass

### Requirement: Lifecycle shutdown and reset are idempotent
Daemon stop and test singleton reset SHALL stop new image acquisitions, cancel queued waiters, abort active work within a bounded shutdown interval, stop cleanup timers, close persistent handles, dispose retired/current generations, and release operation registrations exactly once. Rebuilding in the same process MUST start with zero live queue, scope, timer, mount-handle, or registry state from the prior daemon.

#### Scenario: Daemon stops with queued and active work
- **WHEN** shutdown begins while one job is active and others are waiting
- **THEN** waiters fail without transport, active work receives cancellation, resources are cleaned within the shutdown bound, and no timer keeps the process alive

#### Scenario: Reset follows partial bootstrap failure
- **WHEN** bootstrap fails after creating some image lifecycle components but before listener start
- **THEN** reset/disposal succeeds idempotently and the next bootstrap can register both operations and open the stores once

