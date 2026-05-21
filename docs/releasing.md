# Releasing

BridgeKit is released to npm via GitHub Actions using npm trusted publishing (OIDC). No long-lived `NPM_TOKEN` is stored in repo secrets.

## Workflows

- **`.github/workflows/ci.yml`** — runs on every pull request and on `main` push. Executes `npm run check`, `npm test`, `npm run pack:dry-run`, and `npm run package-smoke`. Required check before merge.
- **`.github/workflows/release.yml`** — runs on `main` push and `workflow_dispatch`. Detects a version bump in `package.json`, re-runs the full gate, and publishes to npm with `--provenance --access public`. Skips publish when no version change is detected.

## How a release happens

1. On a branch, bump `package.json#version` (e.g. `0.1.0` → `0.1.1`). Commit.
2. Open a PR. CI runs the gate.
3. Merge to `main`. `release.yml` detects the version bump, re-runs the gate, then publishes via OIDC. The `npm view` guard fails the run if that version is somehow already on the registry.
4. Optional dry-run: `workflow_dispatch` with `dry_run=true` runs all checks but skips the publish step.

No git tags, no GitHub Releases, no changelog automation in this phase. The `package.json#version` field is the source of truth.

### Failure modes to watch for

The version-bump-as-trigger model conflates "field changed" with "intent to release." Reviewers on `main` PRs must catch the following before merging:

- **Merge-conflict resolution** that picks a higher version from one side of a conflict without the author intending a release.
- **Revert PRs** that revert a version bump. After such a revert, HEAD's version is below the latest registry entry; the next legitimate bump may also be below it, and `npm publish` accepts it — leaving `latest` pointing at an older version than what installed consumers have.
- **Automated dependency tools** (Dependabot, Renovate, etc.) that touch `package.json` and incidentally change the version field.

The mitigation is PR review on `main` under branch protection. If this becomes a recurring source of incidents, switch the trigger model to `workflow_dispatch`-only and remove the `push: branches: [main]` trigger from `release.yml`.

## One-time maintainer setup

Before the first publish via OIDC, the maintainer must do the following on npmjs.com and GitHub.

### Claim the package name (first publish only)

npm trusted publishing requires that the package already exist on the registry. For the very first `@feniix/bridgekit` publish, do a one-time manual publish with a human token:

```sh
npm login
npm publish --access public
```

Do **not** pass `--provenance` from your local machine — provenance attestations require an OIDC provider (GitHub Actions, GitLab CI) and `npm publish` fails with `EUSAGE: Automatic provenance generation not supported for provider: null` when run locally.

(Run `npm run check && npm test && npm run pack:dry-run && npm run package-smoke` locally first.) After this initial publish, all subsequent versions go through the workflow and receive provenance automatically.

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

**Threat-model note.** With this configuration, any merge to `main` that touches `package.json#version` auto-publishes — there is no required second-pair-of-eyes on the publish itself. This is intentional: PR review on `main` under branch protection is the mitigation. The environment gate is treated as optional defence-in-depth, not the primary control. Maintainers who want a stricter posture (e.g., dual control on every release) should switch on **Required reviewers** above and name a reviewer group.

### Branch protection on `main`

1. Repo → *Settings → Branches → Branch protection rules → Add rule* for `main`.
2. Require pull request reviews and require **both** matrix legs of the CI check to pass before merging — `CI / check (22.19)` and `CI / check (24)`. (The matrix creates one status check per Node version; both must be listed individually under "Require status checks to pass before merging".)

## Trusted publishing and provenance

- The workflow uses `permissions: id-token: write` so GitHub mints an OIDC token, which npm exchanges for a short-lived publish credential. No `NPM_TOKEN` is set in the job.
- `--provenance` attaches a signed attestation linking the published tarball to the exact commit, workflow, and runner that built it. Visible on the npm package page.
- Workflows run on Node 24, which bundles an npm CLI with OIDC support. If a future runner image downgrades Node or npm, add `npm install -g npm@latest` to the publish step as a mitigation.

## Pre-publish local gate

Always reproduce the CI gate locally before a release branch:

```sh
npm run check
npm test
npm run pack:dry-run
npm run package-smoke
```

If any step fails, fix it on the branch — do not bypass the workflow.

### Node version coverage

CI runs the gate against a Node matrix covering the declared `engines.node` floor (`22.19`) and the current target (`24`). This catches code that inadvertently uses Node 23+/24-only APIs and would break consumers on Node 22 LTS. Reproduce the floor locally with:

```sh
nvm use 22.19   # or your version manager equivalent
npm run check && npm test && npm run pack:dry-run && npm run package-smoke
```

`release.yml`'s `checks` job stays on Node 24 only — the publish artifact is single and the matrix coverage on PRs and `main` push has already established that the floor passes.

## Promotion criteria

- Start with a prerelease (`0.x`, or an explicit `-rc.N` tag) if downstream consumers have not yet adopted the standalone package.
- Promote to `latest` only after manual fixture validation against `pi-experiments` (or the relevant downstream) and consumer smoke tests pass.
- Do not add `release`, `publish`, changelog-generation, or other registry automation **scripts** in `package.json` — `scripts/verify-bridgekit-dist.mjs` will fail the build. All release logic lives in `.github/workflows/`.

## Bad-version response

Match the response to the failure category.

### Functional bug

1. Deprecate the bad version with a clear npm deprecation message:
   ```sh
   npm deprecate @feniix/bridgekit@<bad-version> "broken: <reason>; use <good-version>"
   ```
2. Patch forward with a new version rather than rewriting published artifacts.
3. Document the incident and add a regression check to `scripts/smoke-package.mjs` or `scripts/verify-bridgekit-dist.mjs`.

### Accidental secret, credential, or PII in the tarball

`npm deprecate` only marks the version; it does **not** remove the artifact. Treat any leaked credential as compromised regardless of how quickly the version is taken down.

1. If the publish is **within 72 hours**, unpublish the affected version:
   ```sh
   npm unpublish @feniix/bridgekit@<bad-version>
   ```
   After 72 hours, npm refuses unpublishes unless you involve npm Support.
2. **Rotate the leaked credential** immediately — assume it has been scraped. Audit any system the credential could reach.
3. Whether or not the unpublish succeeded, deprecate the version with an explicit `"contains leaked credential; rotate and upgrade"` message and supersede it with a clean release.
4. Add a regression check to `scripts/smoke-package.mjs` or `scripts/verify-bridgekit-dist.mjs` that fails the build if the secret pattern re-appears in dist.

### Trusted-publisher compromise

If the npm Trusted Publisher rule, the `npm-release` GitHub environment, or the repo itself appears to have been hijacked (unexpected publishes, repo renamed/transferred without your action, OIDC token used from an unexpected workflow):

1. **Revoke the Trusted Publisher rule** on npmjs.com immediately. This severs the publish channel until you re-establish it.
2. Audit recent publishes by inspecting their provenance attestations on the npm package page — each links to the exact commit, workflow file, and runner. Anything that doesn't trace back to a known commit on `main` is suspect.
3. Disable the `npm-release` GitHub environment (or remove its protection rules) until the investigation is complete.
4. For any suspect publish, follow the *accidental secret* procedure above (unpublish if in window, deprecate, rotate any downstream credentials, supersede).
5. Document the incident and harden the gate — revisit branch protection, environment required-reviewers, and action SHA pinning.

## Open items

- Confirm the current MCP SDK status. If MCP SDK v2 is no longer alpha, decide in a separate migration plan whether to keep v1 or migrate.
- Define pre-1.0 compatibility expectations and release-blocking bug categories.
- Define the maintainer or maintainer group responsible for triage.
