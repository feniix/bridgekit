# Releasing

BridgeKit is released to npm via GitHub Actions using npm trusted publishing (OIDC). No long-lived `NPM_TOKEN` is stored in repo secrets.

## Workflows

- **`.github/workflows/ci.yml`** — runs on every pull request and on `main` push. Installs with `pnpm install --frozen-lockfile` (pnpm version from `package.json#packageManager` via `pnpm/action-setup`), then executes `pnpm audit --prod --audit-level high`, `pnpm run check`, `pnpm test`, `pnpm run pack:dry-run`, and `pnpm run package-smoke`. Required check before merge.
- **`.github/workflows/release.yml`** — runs only on `workflow_dispatch`. Detects whether `package.json#version` is unpublished, re-runs the full gate, and publishes to npm with `--provenance --access public` unless `dry_run=true`. Skips publish when the version is already on npm.

## How a release happens

1. On a branch, bump `package.json#version` (e.g. `0.1.0` → `0.1.1`). Commit.
2. Open a PR. CI runs the gate.
3. Merge to `main`. CI runs the gate on the merge commit.
4. Manually run the **Release** workflow from `main` (`workflow_dispatch`). A workflow guard fails dispatches from any other branch. The workflow checks whether `package.json#version` is unpublished, re-runs the gate, then publishes via OIDC. The `npm view` guard skips the run if that version is already on the registry.
5. Optional dry-run: run the same workflow with `dry_run=true` to execute checks without publishing.

The `package.json#version` field is the source of truth for what version will be published, but it is no longer an automatic publish trigger. After a successful npm publish, the `release_github` job in `release.yml` creates a lightweight `v<version>` tag at the workflow commit and opens a GitHub Release with auto-generated notes (`gh release create --generate-notes`). Tag creation is server-side via the GitHub API, so the tag shows as Verified in the UI. The job is idempotent — if the release already exists (e.g. created manually for a retroactive backfill), it skips. There is no separate changelog automation in this phase; the auto-generated release notes are the changelog.

### Failure modes to watch for

The manual workflow removes the old "version bump on `main` auto-publishes" failure mode, but maintainers still need to check:

- **Wrong ref selected in the manual workflow.** The workflow has a branch guard and fails unless dispatched from `main`; if it fails here, rerun it from `main` after CI is green.
- **Merge-conflict resolution** that picks a higher version from one side of a conflict without the author intending a release.
- **Revert PRs** that revert a version bump. After such a revert, HEAD's version can be below the latest registry entry; the release workflow will skip already-published versions, but maintainers should choose the next forward version deliberately.
- **Automated dependency tools** (Dependabot, Renovate, etc.) that touch `package.json` and incidentally change the version field.

The mitigation is PR review on `main`, green CI, and the manual Release workflow dispatch.

## One-time maintainer setup

Before the first publish via OIDC, the maintainer must do the following on npmjs.com and GitHub.

### Claim the package name (first publish only)

npm trusted publishing requires that the package already exist on the registry. For the very first `@feniix/bridgekit` publish, do a one-time manual publish with a human token:

```sh
npm login
npm publish --access public
```

Do **not** pass `--provenance` from your local machine — provenance attestations require an OIDC provider (GitHub Actions, GitLab CI) and `npm publish` fails with `EUSAGE: Automatic provenance generation not supported for provider: null` when run locally.

(Run `pnpm run check && pnpm test && pnpm run pack:dry-run && pnpm run package-smoke` locally first.) After this initial publish, all subsequent versions go through the workflow and receive provenance automatically.

The seed version published this way ships **without** a provenance attestation — supply-chain scanners and consumers that treat provenance as a trust signal will flag it. To minimise the unattested-version window, immediately follow the bootstrap publish with a workflow-driven patch bump so the first version consumers are encouraged to pin to is attested. Document the first attested version in the README and recommend pinning from there.

### Configure trusted publishing on npm

1. Go to https://www.npmjs.com/package/@feniix/bridgekit/access (or the package's *Settings → Trusted Publisher* tab).
2. Add a **GitHub Actions** publisher with:
   - **Repository owner:** `feniix`
   - **Repository name:** `bridgekit`
   - **Workflow filename:** `release.yml`
   - **Environment name:** `npm-release`
3. Save.

### Create the GitHub deployment environment

1. Repo → *Settings → Environments → New environment* → name it `npm-release`.
2. (Recommended) Add **Required reviewers** so a publish needs human approval.
3. (Recommended) Restrict the environment to the `main` branch under *Deployment branches*.

**Threat-model note.** Publishing now requires an explicit `workflow_dispatch` run, and the `npm-release` environment remains the final publish gate. For dual control on every release, switch on **Required reviewers** and name a reviewer group; otherwise, the manual workflow dispatch plus branch protection is the primary control.

### Branch protection on `main`

1. Repo → *Settings → Branches → Branch protection rules → Add rule* for `main`.
2. Require pull request reviews and require the `CI / check` status check to pass before merging.

## Trusted publishing and provenance

- The workflow uses `permissions: id-token: write` so GitHub mints an OIDC token, which npm exchanges for a short-lived publish credential. No `NPM_TOKEN` is set in the job.
- Third-party GitHub Actions are pinned by full commit SHA (with the source tag in a YAML comment) to reduce retagging/supply-chain risk.
- `--provenance` attaches a signed attestation linking the published tarball to the exact commit, workflow, and runner that built it. Visible on the npm package page.
- Workflows run on Node 22, matching pi. Node 22 bundles npm 10.x, which cannot do trusted publishing (it needs npm `>=11.5.1`), so the publish job first runs `npm install -g npm@11.16.0 --ignore-scripts` — the same pinned npm pi's publish job uses. Bump that pin deliberately.
- Dependencies are installed with pnpm (`pnpm install --frozen-lockfile`), but the publish step deliberately stays on `npm publish --access public --provenance`: npm is the CLI whose trusted-publishing exchange and provenance generation this release flow was set up and verified with. Its `prepack` hook runs `pnpm run build`, so the publish job also runs `pnpm/action-setup`. Switching to `pnpm publish` is a separate change that needs its own verified release.
- The publish job intentionally omits dependency caching; only `ci.yml` and the release `checks` job use `cache: pnpm`.
- Keep the `npm-release` environment name and the `release.yml` filename unchanged — both are part of the npm Trusted Publisher rule.

## Pre-publish local gate

Always reproduce the CI gate locally before a release branch:

```sh
corepack enable            # or any pnpm installer that honours package.json#packageManager
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run pack:dry-run
pnpm run package-smoke
pnpm audit --prod --audit-level high
```

If any step fails, fix it on the branch — do not bypass the workflow.

### MCP conformance status

The local gate tests BridgeKit's dual-era stdio runner; it does **not** certify
official MCP conformance. The checked official conformance CLI (`0.1.16`) requires
an HTTP URL for server tests and cannot directly launch the stdio fixture.
Do not add a nominal conformance CI job that tests an HTTP bridge instead and
reports it as stdio coverage.

For releases changing the MCP SDK or stdio lifecycle, manually recheck the
suite's transport support and record the version and outcome in
[the conformance research note](research/mcp-stdio-conformance.md). Once direct
stdio support exists, run the tools/lifecycle scenarios for both `2025-11-25`
and `2026-07-28`, inspect failures before introducing any baseline, and evaluate
a pinned CI gate. Until then, #130 remains blocked rather than passed.

### Node version coverage

CI and every release job run on Node `22` (the latest 22.x), matching pi's workflows, which build, test, and publish on a single Node 22 line with no matrix. The `engines.node` floor (`>=22.19.0`) also matches pi's packages. Reproduce CI locally with:

```sh
nvm use 22   # or your version manager equivalent
pnpm run check && pnpm test && pnpm run pack:dry-run && pnpm run package-smoke
```

## Promotion criteria

- Start with a prerelease (`0.x`, or an explicit `-rc.N` tag) if downstream consumers have not yet adopted the standalone package.
- Promote to `latest` only after manual fixture validation against `pi-experiments` (or the relevant downstream) and consumer smoke tests pass.
- Do not add `release`, `publish`, changelog-generation, or other registry automation **scripts** in `package.json` — `scripts/smoke-package.mjs` will fail (see `inv-no-release-publish-scripts` in `docs/packaging-invariants.md`). All release logic lives in `.github/workflows/`.

## Bad-version response

Match the response to the failure category.

### Functional bug

1. Deprecate the bad version with a clear npm deprecation message:
   ```sh
   npm deprecate @feniix/bridgekit@<bad-version> "broken: <reason>; use <good-version>"
   ```
2. Patch forward with a new version rather than rewriting published artifacts.
3. Document the incident and add a regression check to `scripts/smoke-package.mjs`.

### Accidental secret, credential, or PII in the tarball

`npm deprecate` only marks the version; it does **not** remove the artifact. Treat any leaked credential as compromised regardless of how quickly the version is taken down.

1. If the publish is **within 72 hours**, unpublish the affected version:
   ```sh
   npm unpublish @feniix/bridgekit@<bad-version>
   ```
   After 72 hours, npm refuses unpublishes unless you involve npm Support.
2. **Rotate the leaked credential** immediately — assume it has been scraped. Audit any system the credential could reach.
3. Whether or not the unpublish succeeded, deprecate the version with an explicit `"contains leaked credential; rotate and upgrade"` message and supersede it with a clean release.
4. Add a regression check to `scripts/smoke-package.mjs` that fails the build if the secret pattern re-appears in dist.

### Trusted-publisher compromise

If the npm Trusted Publisher rule, the `npm-release` GitHub environment, or the repo itself appears to have been hijacked (unexpected publishes, repo renamed/transferred without your action, OIDC token used from an unexpected workflow):

1. **Revoke the Trusted Publisher rule** on npmjs.com immediately. This severs the publish channel until you re-establish it.
2. Audit recent publishes by inspecting their provenance attestations on the npm package page — each links to the exact commit, workflow file, and runner. Anything that doesn't trace back to a known commit on `main` is suspect.
3. Disable the `npm-release` GitHub environment (or remove its protection rules) until the investigation is complete.
4. For any suspect publish, follow the *accidental secret* procedure above (unpublish if in window, deprecate, rotate any downstream credentials, supersede).
5. Document the incident and harden the gate — revisit branch protection, environment required-reviewers, and action SHA pinning.

## Compatibility expectations

While BridgeKit is pre-1.0:

- `0.x.0` (minor) bumps may include source-level breaking changes — generic signatures, type narrowing, exported symbol renames. Adapter contract drift is documented in the changelog.
- `0.x.y` (patch) bumps are bug fixes and additive type changes only. Existing consumer code that compiled and ran on `0.x.0` must still compile and run on `0.x.y`.

From `1.0.0` onward: semver, with explicit `@deprecated` cycles preceding any removal. The current `PortableToolResult#details` deprecation is the first such cycle.

Release-blocking bug categories (any of these warrants holding a release):

- A consumer install fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for one of the documented entrypoints.
- TypeScript fails to compile against the published declarations under strict-plus (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) + `NodeNext`.
- The pi/MCP adapter divergence regresses (validated by `src/adapters/compliance.test.ts`).
- Any `scripts/smoke-package.mjs` assertion fails on the release-target Node versions.

## MCP SDK stance

The implementation for #117 uses `@modelcontextprotocol/server` SDK v2, with
low-level method-string handlers and dual-era stdio serving. The v1 SDK and v2
client are development-only compatibility/test dependencies. The no-high-level-
registration-helper policy is unchanged: TypeBox remains JSON Schema passthrough.

Release this migration as a pre-1.0 minor, not a patch: `createMcpServer` exposes a
different SDK `Server` type/object. Keep legacy wire interoperability. The
upcoming lifecycle change also requires a minor: the runner now returns
`Promise<McpStdioServerHandle>`. See [migration policy](mcp-v2-migration.md);
the packed smoke test exercises both eras and pins the v2 server baseline.

## Maintainer & triage

### Selected HTTP conformance checks

With `scripts/mcp-http-fixture.mjs` running after a build, manually run the
four pinned official HTTP scenarios listed in
[the conformance record](research/mcp-stdio-conformance.md#http-follow-up-2026-10-07).
Keep the result artifacts. These do not certify stdio or modern `2026-07-28`;
the published `0.1.16` harness rejects that dated version. Do not make the
full-suite or dual-era conformance claim until those blockers are resolved.

Issue triage: maintainer responsibility is unassigned. Until a triage owner is named, expect best-effort response on issues filed against this repository, with priority on packaging regressions, install failures, and SDK-compatibility breaks.

## Open items

None at this time. Previous open items (MCP SDK v2 status, pre-1.0 compatibility expectations, maintainer responsibility) are now addressed in the dedicated sections above.
