# Task Completion — @feniix/bridgekit

## Standard task (code edit, bug fix, feature)

Run in order:

1. `npm run check` — `biome check .` + `tsc -b --pretty false`. **Pre-commit gate.**
2. `npm test` — builds (rebuild required for edits to be visible) + Node's `--test` against `dist/src/**/*.test.js`.

If either fails, fix before declaring done. There is no separate command for `*.integration.test.ts` — they are picked up by the same glob.

## Pre-publish / packaging-affecting change

Run the **full gate** before tagging or publishing:

```
npm run check && npm run test && npm run pack:dry-run && npm run package-smoke
```

- `pack:dry-run` — `npm pack --dry-run --json`. `prepack` runs `build` automatically.
- `package-smoke` — `scripts/smoke-package.mjs` packs a tarball into a temp dir, installs it into a synthetic consumer, and asserts the public surface (export keys, deep-import refusal, source-map absence, no `release`/`publish` scripts, etc.). Per-check catalog in `docs/packaging-invariants.md`.

## After type-only or generic changes

If touching `src/core/define-tool.ts` or `src/core/execute-tool.ts` (especially anything around `PortableTool`'s `TParams` generic, the host-union shape, or `PortableToolResult`), confirm the typecheck fixtures still compile:

- `src/core/result-generic.typecheck.ts`
- `src/adapters/mcp.typecheck.ts`
- `src/adapters/pi.typecheck.ts`

They are compile-only and contain `@ts-expect-error` markers. `npm run typecheck` (run by `check`) covers them.

## Release flow

There is intentionally no `release` or `publish` script. Follow `docs/releasing.md`.
