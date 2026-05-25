# Suggested Commands — @feniix/bridgekit

All scripts local-only. There is **no** `release` or `publish` script and adding one will fail `scripts/smoke-package.mjs` (`inv-no-release-publish-scripts`).

## Day-to-day

- `npm run check` — `biome check .` + `tsc -b --pretty false`. Standard pre-commit gate.
- `npm run lint:fix` — `biome check --write .`.
- `npm run typecheck` — `tsc -b tsconfig.json --pretty false`.
- `npm run build` — `clean` + `tsc -b`. Output in `dist/src/**`.

## Testing

Test runner is **Node's built-in `--test`**, not vitest/jest. Tests are TS in `src/`, executed from `dist/src/`. **You must rebuild before edits are visible to tests.**

- `npm test` — builds, then `scripts/run-built-tests.mjs` collects `dist/src/**/*.test.js`.
- `npm run test:coverage` — same, with `--experimental-test-coverage` scoped to `dist/src/**`.
- Single test file (after build): `node --test dist/src/adapters/mcp.test.js`.
- Filter by name: append `--test-name-pattern "..."`.
- Tests import the package by name (`@feniix/bridgekit`, `/pi`, `/mcp`) via Node self-referencing — exercises the real `exports` map.

## Packaging / pre-publish

- `npm run pack:dry-run` — `npm pack --dry-run --json`. `prepack` auto-runs `build`.
- `npm run package-smoke` — packs tarball into temp dir, installs into synthetic consumer, asserts public surface (`scripts/smoke-package.mjs`).
- **Pre-publish full gate**: `npm run check && npm run test && npm run pack:dry-run && npm run package-smoke`.

## Darwin-specific notes

None. Standard unix utilities (`ls`, `grep`, `find`, `git`) behave as expected on this project. No GNU-flag traps in tracked scripts.
