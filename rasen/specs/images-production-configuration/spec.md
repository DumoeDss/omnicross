# images-production-configuration Specification

## Purpose
TBD - created by archiving change codex-images-production-wiring. Update Purpose after archive.
## Requirements
### Requirement: Default-off normalized Images configuration
The daemon SHALL persist and expose one nested Images server configuration covering enablement, the `codex-subscription` provider, default model and aliases, optional account or account-group binding, queue and generation timeouts, finite Image API limits, shared temporary-scope/byte quotas, reference/state quotas and TTLs, storage policy, remote-input policy, cleanup cadence, and capability-evidence TTL. Missing or legacy configuration MUST normalize to Images disabled, `gpt-image-2`, one active job per account, a bounded queue, finite hard-safe limits, a 24-hour reference TTL, remote URLs disabled, and separate private temporary and durable roots under daemon-owned application data outside every Git worktree.

#### Scenario: Existing installation has no Images segment
- **WHEN** the daemon loads settings written before the Images segment existed
- **THEN** the four existing text endpoint configurations retain their behavior and Images normalizes to safe finite defaults with `enabled` false

#### Scenario: Configuration does not establish capability
- **WHEN** an administrator enables Images and selects `gpt-image-2` but fresh account/protocol evidence is absent
- **THEN** the configuration is stored as enabled while effective image capability remains unavailable and no entitlement is inferred

#### Scenario: Default storage is outside the worktree
- **WHEN** no image storage root is configured
- **THEN** the daemon resolves private temporary and durable host-data locations and never writes image content beneath the process workspace or Git worktree

### Requirement: Strict failure-atomic configuration updates
The authenticated admin update boundary SHALL validate the complete Images segment strictly before persistence or runtime publication. It MUST reject unknown providers or members, unsupported model aliases, simultaneous account ID and group selection, invalid fallback policy, unsafe or worktree-contained roots, non-positive or non-integer budgets, values above frozen hard ceilings, aggregate limits smaller than their members, impossible TTL/cleanup relationships, and enabled remote loading without a proven safe resolver; any rejection MUST leave both persisted and active configurations unchanged.

#### Scenario: Aggregate budget is inconsistent
- **WHEN** an update sets total input, output, tenant, or store capacity below a required per-item bound
- **THEN** the admin API returns 400 and neither the settings store nor active runtime generation changes

#### Scenario: Account binding is ambiguous
- **WHEN** an update supplies both a fixed account ID and an account group
- **THEN** validation rejects the update before resolving credentials or constructing a provider

#### Scenario: Remote URL policy lacks a safe resolver
- **WHEN** an update enables remote image URLs on a platform or configuration where per-hop address pinning and revalidation cannot be established
- **THEN** validation fails closed and remote network fetching remains disabled

#### Scenario: Unknown Images member is submitted
- **WHEN** an administrator submits a misspelled or unsupported field in the Images segment
- **THEN** the update returns 400 instead of silently discarding the field or applying a partial configuration

### Requirement: Exact provider and account policy
Each normalized configuration SHALL select only an explicitly supported image provider and SHALL express fixed-account, account-group, and strict-versus-pool fallback policy without embedding credentials. Runtime construction MUST resolve these hints through the existing subscription authentication/account-selection mechanisms, and admin/UI output MUST use safe display metadata rather than raw account identifiers or authentication material.

#### Scenario: Fixed account is unavailable under strict policy
- **WHEN** Images is bound to one account with strict fallback and that account cannot produce a valid Codex credential
- **THEN** the image runtime reports `upstream_auth_required` or unavailable without selecting a different account

#### Scenario: Pool policy chooses an eligible account
- **WHEN** group/pool fallback is configured and the existing auth strategy selects an eligible account
- **THEN** the resulting provider lease keeps that account bound to evidence, queue identity, refresh, dispatch, and attribution for the request

#### Scenario: Configuration is read through admin UI
- **WHEN** the API Service UI loads the Images configuration
- **THEN** it receives provider and safe account-policy fields without tokens, Cookies, full account IDs, storage paths, or private provider-wire values

### Requirement: Generation-pinned hot reload
Images configuration changes SHALL be applied through a runtime-generation manager and a failure-atomic server-config transaction. The transaction MUST validate and fully prepare all fallible work, atomically persist the merged settings, and only then publish prepared runtime/listener snapshots; publication MUST be an infallible swap after preparation. Persistence failure MUST dispose the unpublished replacement. Unexpected publish failure MUST restore the previous persisted document and every already-published snapshot before returning failure. New acquisitions MUST use the committed snapshot, while queued, accepted, or hosted requests holding the prior generation MUST keep its provider, evidence, queue timeout, generation timeout, limits, and stores until final cleanup and release.

#### Scenario: Ordinary update is published atomically
- **WHEN** a valid Images update produces a complete replacement runtime
- **THEN** one atomic publication makes it visible to later requests without unregistering the stable operation contributions

#### Scenario: Request spans hot reload
- **WHEN** a queued or active Images request holds a generation lease while configuration is replaced
- **THEN** that request completes or fails under its original snapshot and a later request uses the replacement snapshot

#### Scenario: Replacement construction fails
- **WHEN** provider registration, storage mount, evidence store, scheduler binding, or contribution creation fails for the proposed configuration
- **THEN** the update reports failure, disposes only the unpublished generation, and leaves the previous persisted and active generation usable

#### Scenario: Settings persistence fails after preparation
- **WHEN** a valid replacement generation is prepared but the atomic settings-file replacement fails
- **THEN** the replacement is disposed, the old settings bytes and active runtime remain authoritative, and no applied audit event is emitted

#### Scenario: Publication unexpectedly fails
- **WHEN** one prepared participant fails during the commit phase after settings persistence
- **THEN** the coordinator restores the prior persisted document and published snapshots, reports failure, and does not leave Images configured differently from the outbound listener

#### Scenario: Disabled configuration is published
- **WHEN** an administrator disables Images
- **THEN** later acquisitions fail closed while already accepted work is allowed to finish on its pinned generation before retirement

### Requirement: Versioned persistent storage mounts
The storage catalog SHALL outlive individual runtime generations and SHALL record versioned mounted backends so a storage-root change does not invalidate already published image call/reference IDs. New writes MUST use the newly validated active backend, old backends MUST remain available for authorized resolution until their last retained value expires, is deleted, or is explicitly migrated, and empty retired mounts MUST be removable without following symlinks or exposing their paths.

#### Scenario: Storage root changes with live references
- **WHEN** a valid hot reload selects a new storage root while unexpired references exist in the old backend
- **THEN** new artifacts use the new backend and authorized old references remain resolvable through the mounted catalog

#### Scenario: Daemon restarts after a root change
- **WHEN** the daemon restarts with references distributed across current and retired mounts
- **THEN** it restores the validated mount manifest before serving Images and preserves each reference's tenant and expiry behavior

#### Scenario: Retired mount becomes empty
- **WHEN** cleanup removes the final unleased value from a retired backend
- **THEN** the catalog can retire that mount atomically without changing the active backend or disclosing its filesystem path

### Requirement: Configuration administration and policy audit
The daemon DTOs, settings store, admin API, API Service adapter, UI forms, and translations SHALL round-trip the normalized Images configuration without coercing unsafe values. Successful changes to enablement, provider, account binding, storage root, remote-input policy, limits, TTLs, or queue policy MUST emit metadata-only configuration audit events; failed validation MUST NOT emit a misleading applied event.

#### Scenario: UI saves a valid Images policy
- **WHEN** an administrator submits a valid Images form
- **THEN** the UI reflects the daemon-normalized values returned by the atomic update and distinguishes configured enablement from effective capability

#### Scenario: Sensitive policy value is audited
- **WHEN** provider binding or storage policy changes successfully
- **THEN** the audit record identifies the safe field category and generation transition without raw account IDs, filesystem paths, credentials, or old/new secret-bearing values

#### Scenario: Existing text configuration survives Images update
- **WHEN** only the Images segment is updated
- **THEN** bindings, models, queues, audit, billing, and all other pre-existing server settings remain unchanged

