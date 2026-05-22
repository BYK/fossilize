# Agents

## Project Overview

Fossilize is a CLI tool that creates Node.js Single Executable Applications (SEA) for multiple platforms. It bundles a Node.js app using esbuild, downloads platform-specific Node.js binaries, and injects the bundle using postject.

## Tech Stack

- **Language:** TypeScript (type-check only via `tsc --noEmit`, bundled by tsup)
- **Build:** tsup (ESM, code-splitting, minification)
- **Package manager:** npm (not pnpm/yarn)
- **Node version:** Pinned via Volta in package.json (`22.14.0`)
- **CLI framework:** Stricli

## Release & Publishing

This repo uses [getsentry/craft](https://github.com/getsentry/craft) for automated releases, following the `publish_repo: self` pattern (publish issues are created in this repo, not a separate publish repo).

### Release flow
1. Maintainer triggers the **Release** workflow (`workflow_dispatch`) with version `auto` or explicit
2. Craft creates `release/X.Y.Z` branch, bumps `package.json`, generates `CHANGELOG.md`, opens publish issue
3. CI runs on the release branch — `build` + `test` + `artifacts` jobs (artifacts packs npm tarball)
4. Maintainer adds `accepted` label to the publish issue
5. **Publish** workflow fires, runs `craft publish` which publishes to npm (OIDC) and creates a GitHub Release
6. Issue auto-closes on success

### Key files
- `.craft.yml` — Craft configuration (npm + github targets, artifact provider maps `Build & Test` workflow)
- `.github/workflows/build.yml` — CI: build, smoke test, artifact packing on release branches
- `.github/workflows/release.yml` — Manual trigger for `craft prepare`
- `.github/workflows/publish.yml` — Issue-label-triggered `craft publish`

### Prerequisites for releasing
- GitHub App with `contents: write` and `issues: write` permissions
  - Repo variable `APP_CLIENT_ID` and secret `APP_PRIVATE_KEY`
- GitHub environment `production` on the repo
- npm OIDC provenance linked for the `fossilize` package

### npm publishing
- Uses OIDC authentication (no `NPM_TOKEN` secret needed)
- Package is published with `public` access
- The `artifacts` job in CI packs the tarball using `npm pack` after downloading the pre-built `dist/` artifact

<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

For long-term knowledge entries managed by [lore](https://github.com/BYK/loreai) (gotchas, patterns, decisions, architecture), see [`.lore.md`](.lore.md) in the project root.
<!-- End lore-managed section -->
