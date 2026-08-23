# Desktop updates and release signing

Omnicross desktop checks the latest stable GitHub Release five seconds after a
packaged build starts. The check is detached from window and daemon startup and
has an eight-second metadata timeout. Network or manifest failures on this
automatic path are diagnostic-only. Update discovery is always enabled;
**Automatically download updates** is opt-in, defaults to off, and controls only
whether a compatible update is downloaded after discovery. Installation and
restart always require an explicit user action.

## Trust and supported packages

The native updater reads
`https://github.com/Dumoedss/omnicross/releases/latest/download/latest.json`
through `tauri-plugin-updater` and verifies downloaded bytes with the public key
committed in `apps/desktop/src-tauri/tauri.conf.json`. The application accepts
only a stable SemVer newer than its running Tauri package version.

In-app installation is deliberately limited to these signed targets:

| Manifest target | In-app package | Manual-only packages |
| --- | --- | --- |
| `windows-x86_64` | Windows x64 NSIS | MSI |
| `darwin-universal` | macOS universal `.app.tar.gz` | DMG |
| `linux-x86_64` | Linux x86_64 `.AppImage` | deb, rpm |

An unsupported architecture or installed package never receives a mismatched
installer; users can open the GitHub Release page instead.

## Protected repository secrets

The release environment must define both protected GitHub Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — the complete Minisign private-key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

Do not commit, paste into workflow YAML, echo, or attach either value to a
release. Keep an offline, access-controlled backup of the key and password. The
workflow fails before creating build jobs when either secret is absent. The
private key generated for this repository is intentionally stored outside the
worktree; only its public key belongs in Git.

To provision the secrets, a repository administrator should use an authenticated
GitHub CLI session and feed values over standard input so they do not appear in
shell history or process arguments. On Windows, a DPAPI-protected password can be
decrypted only by the user account that created it. Never print the decrypted
value; pipe it directly into `gh secret set`.

For rotation, first ship a transition release signed by the old key whose app
configuration contains the new public key. Only after supported clients can
install that transition release should later releases be signed by the new key.
Keep the old key available during the migration window; losing it before a
transition release strands existing clients.

## Release workflow

1. Push a stable `vMAJOR.MINOR.PATCH` tag or invoke the Release workflow with
   that exact tag. Drafts and prereleases are never selected by `/releases/latest`.
2. `prepare-release` validates tag/config parity, protected-secret presence, and
   creates or reuses a **draft** release. Drafts are untagged until publication,
   so downstream jobs pin the Releases API `target_commitish` instead of assuming
   `refs/tags/<version>` already exists. It refuses an already-published tag or a
   same-name draft that points at a different commit.
3. Three platform jobs build manual packages plus signed updater artifacts. They
   explicitly disable per-job updater JSON generation.
4. After every platform succeeds, the sole `finalize-updater` job downloads all
   draft assets and cryptographically verifies every updater artifact/signature
   pair against the public key committed in `tauri.conf.json`. Only then does it
   assemble one `latest.json`, validate version/target/HTTPS URL/signature
   coverage, upload it, and verify the uploaded bytes.
5. A maintainer reviews and smoke-tests the draft before pressing Publish. A
   draft does not affect the stable `latest` endpoint.

Never reuse a tag or replace artifacts under a published tag. Fixes require a new
version and a new signed release so the immutable manifest-to-asset relationship
remains auditable.

## Local and CI verification

Run the release contract without contacting production:

```sh
npm run test:release-contract
node packages/ui/scripts/check-i18n.mjs
```

The fixture suite rejects missing targets/signatures, mutable or non-HTTPS URLs,
prerelease/mismatched tags, Tauri-version mismatches, modified signed bytes,
wrong public keys, and malformed signatures. It covers Tauri's current direct
`.AppImage` updater artifact and the legacy `.AppImage.tar.gz` form. A real
signed draft and install/relaunch smoke test still requires protected repository
secrets plus Windows, macOS, and Linux packaging environments.
