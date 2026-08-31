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
```

`release:prepare` updates these sources together while preserving their existing
line endings:

- root and desktop `package.json` files;
- all six publishable workspace manifests;
- internal `@omnicross/*` dependency minimums;
- `package-lock.json` workspace entries;
- the Tauri application version.

Review and commit the resulting diff, then create and push the matching tag:

```bash
git commit -am "chore(release): v0.1.15"
git tag v0.1.15
git push origin HEAD v0.1.15
```

Do not create the tag before committing the prepared files. The release workflow
runs `release:check` before it creates or reuses a draft and rejects every tag or
manifest mismatch.

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
