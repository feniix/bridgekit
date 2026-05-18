# Future release checklist

This document is a handoff note for a future release plan. It does not authorize or perform publishing work for the extraction phase.

## Before the first npm publish

- Add CI that runs the standalone verification gates on pull requests and `main`.
- Configure npm trusted publishing and GitHub environment protections.
- Re-run the package smoke against a packed tarball in a clean temporary consumer.
- Manually validate downstream fixture packages from `pi-experiments` against the packed BridgeKit tarball before any source-of-truth flip.
- Confirm the current MCP SDK status. If MCP SDK v2 is no longer alpha, decide in a separate migration plan whether to keep v1 or migrate.
- Choose the release version in the release plan, not in this extraction record.
- Define the maintainer or maintainer group responsible for triage.
- Define pre-1.0 compatibility expectations and release-blocking bug categories.

## Trusted publishing and provenance

- Use npm trusted publishing rather than long-lived registry tokens.
- Require CI to run `npm pack --dry-run --json`, `npm run verify:dist`, and `npm run package-smoke` before publication.
- Verify package provenance and packed file contents before promoting any release tag.

## Promotion criteria

- Start with a prerelease or explicit validation window if downstream consumers have not yet moved to the standalone package.
- Promote to `latest` only after manual fixture validation and consumer smoke tests pass.
- Do not add `release`, `publish`, changelog-generation, or registry automation scripts until CI and trusted publishing are in place.

## Bad-version response

If a published version is broken:

1. Deprecate the bad version with a clear npm deprecation message.
2. Patch forward with a new version rather than rewriting published artifacts.
3. Document the incident and add a regression check to `scripts/smoke-package.mjs` or `scripts/verify-bridgekit-dist.mjs`.
