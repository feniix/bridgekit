# Commands & tooling

## npm scripts (`package.json`)
- `npm run lint` — Biome check across the repo.
- `npm run lint:fix` — Biome check with `--write`.
- `npm run typecheck` — `tsc -b tsconfig.json --pretty false`.
- `npm run check` — lint + typecheck (the standard pre-commit gate).
- `npm run clean` — `node scripts/clean-package-dist.mjs` (clears `dist/`).
- `npm run build` — clean + `tsc -b`.
- `npm run test` — build, then `node scripts/run-built-tests.mjs` (runs tests against compiled output in `dist/`).
- `npm run test:coverage` — build, then `node scripts/run-built-tests-coverage.mjs` (Node's `--experimental-test-coverage`, scoped to `dist/src/**` and excluding `.test.js` / `.typecheck.js`).
- `npm run verify:dist` — `node scripts/verify-bridgekit-dist.mjs` (sanity-checks the dist layout).
- `npm run pack:dry-run` — `npm pack --dry-run --json`.
- `npm run package-smoke` — `node scripts/smoke-package.mjs` (consume the packed tarball).
- `npm run prepack` — build + verify:dist (runs automatically on `npm pack`/`publish`).

## Pre-publish checklist (from README)
Run before publishing:
1. `npm run check`
2. `npm run test`
3. `npm run pack:dry-run`
4. `npm run package-smoke`

`docs/releasing.md` is the canonical (future) release handoff. Repo is **not** configured for automated publish yet.

## Scripts (`scripts/`)
- `clean-package-dist.mjs` — wipes `dist/`.
- `run-built-tests.mjs` — discovers and runs tests from `dist/`.
- `smoke-package.mjs` — packs and consumes the tarball to validate published surface.
- `verify-bridgekit-dist.mjs` — validates compiled dist layout / declarations.

## Toolchain versions
- Node `>=22.19.0`
- TypeScript `^5.5.0`
- Biome `2.4.10`
- `@total-typescript/shoehorn` for type-narrowing in tests
- MCP SDK `^1.29.0`, TypeBox `^1.1.31`

## Test runner
The project uses Node's built-in test runner via `scripts/run-built-tests.mjs` (not vitest/jest). Tests are authored in TS, compiled, then executed from `dist/`.

Tests import the package by name (`@feniix/bridgekit`, `@feniix/bridgekit/pi`, `@feniix/bridgekit/mcp`) using Node self-referencing — this exercises the real `exports` map rather than source layout. **A fresh source edit is invisible to tests until `tsc` re-emits**, so `npm test` always builds first.

To run a single compiled test file directly (after `npm run build`):
```sh
node --test dist/src/adapters/mcp.test.js
node --test --test-name-pattern "validation" dist/src/core/execute-tool.test.js
```
