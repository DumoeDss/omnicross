# Releasing Omnicross

Omnicross uses one lockstep version for the desktop application, the repository,
and all six public `@omnicross/*` workspace packages. A release tag must never be
used as a CI-only version override.

## Prepare the release commit

From a clean release branch, choose the next stable version and run:

```bash
npm run release:prepare -- 0.1.15
npm run release:check -- 0.1.15
npm run test:release-contract
npm run audit:codex-sessions
```

`release:prepare` updates these sources together while preserving their existing
line endings:

- root and desktop `package.json` files;
- all six publishable workspace manifests;
- internal `@omnicross/*` dependency minimums;
- `package-lock.json` workspace entries;
- the Tauri application version.

Use Node.js 22 or newer for contributor/release tooling; the official OpenAI
SDK development dependency requires it. This does not raise the published
core runtime minimum of Node.js 20.9.

`audit:codex-sessions` replays the maintainer's OWN recent codex session
history (`~/.codex/sessions`, last 7 days by default) through the
reduced-Responses admission gate. It is the check that catches a codex CLI
upgrade recording request shapes the relay would 400 on BEFORE those shapes
reach users — the unit suite cannot see them, because they are real-world
recordings. On a machine with no codex sessions it is a no-op pass; on CI it
therefore adds no signal, which is why it gates the maintainer's release
sequence rather than the workflow. A failure names the exact JSON path of the
rejected shape; fix the gate before tagging, the same way a `release:check`
failure is treated.

Review and commit the resulting diff, then create and push the matching tag:

```bash
git commit -am "chore(release): v0.1.15"
git tag v0.1.15
git push origin HEAD v0.1.15
```

Do not create the tag before committing the prepared files. The release workflow
runs `release:check` before it creates or reuses a draft and rejects every tag or
manifest mismatch.

## Validate the npm runtime closure

After `npm ci`, run `npm run build`, `npm run typecheck`, `npm test`,
`npm run test:release-contract`, and `npm run test:daemon-runtime-packaging`.
Validate packed archives in a fresh consumer outside the repository, not through
workspace links: install the daemon tarball with the other five public packages
pinned to their local tarballs, then exercise ESM/CJS imports, strict public
declarations, and `omnicross --help`.

`@omnicross/chatgpt-web` intentionally remains private and is **not** a seventh
public npm package or part of the public lockstep version. The daemon's
`prepack` stages its built artifacts, licenses, standalone server/browser assets,
and installed production dependency closure into the daemon tarball through
`bundleDependencies`. Versions must match `package-lock.json`; packing does not
resolve new versions or install dependencies. Do not bypass `prepack` when
packing or publishing the daemon. A normal daemon consumer does not need a
separate private-package tarball or registry access to that package.

`release:check` rejects public runtime dependencies on private workspaces unless
they are bundled. `test:release-contract` also checks the staging transaction's
junction protection, rollback, and post-commit cleanup failures. The desktop
runtime uses the same six public tarballs and the bundled private closure.

## Automated publication

The repository must provide `NPM_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as GitHub Actions secrets.

For a valid tag, the release workflow:

1. builds all supported desktop targets into one signed draft;
2. builds and publishes the six npm packages in dependency order;
3. verifies that every exact package version is visible on npm;
4. creates and validates the signed updater manifest;
5. leaves the GitHub release as a draft for maintainer review.

The npm step is safe to rerun after a partial failure: exact versions already on
npm are skipped and the remaining packages continue in dependency order. The
updater manifest is not finalized unless the complete npm publication succeeds.
