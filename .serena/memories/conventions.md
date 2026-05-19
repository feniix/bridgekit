# Conventions & best practices

From `README.md` and `llms.txt`:

## Tool authoring
- Keep tool files **host-neutral**: no pi imports, no MCP SDK imports.
- Use TypeBox `Type.Object(...)` schemas (required for MCP `inputSchema` passthrough).
- Return `text` for model-visible output, `structuredContent` for machine-readable data.
- Use `isError: true` for expected/domain failures.
- Throw only for unexpected programmer/adapter/runtime failures.
- Respect `ctx.signal` in long-running tools.
- Use `ctx.progress?.(update)` for incremental updates.
- Modules must be **import-passive**: never register tools or start servers at import time.

## Packaging
- Publish compiled JS + generated `.d.ts`, not source as runtime code.
- `exports`, `main`, `types` must stay aligned with built files.
- Runtime deps go in `dependencies` (currently `@modelcontextprotocol/sdk`, `typebox`).
- No `workspace:` / `file:` ranges in publishable packages.
- Don't ship dangling `sourceMappingURL` comments without their maps.

## Code style
- Biome (`biome.json`) is the formatter+linter. Run `npm run lint` / `npm run lint:fix`.
- File naming: kebab-case `.ts`; tests as `*.test.ts`; integration tests as `*.integration.test.ts`; compile-only type checks as `*.typecheck.ts`.
- `.test.*`, `.typecheck.*`, and `.map` files are excluded from the published tarball via the `files` field.

## Imports
- Consumers must use the three public entrypoints only — never deep-import `dist/` or `src/`.
- Internal imports use `.js` extensions (ESM + Node resolution): `from "./define-tool.js"`.

## Tests
- Live next to source under `src/`.
- Run via `npm test`, which builds first then executes `scripts/run-built-tests.mjs` against the compiled output in `dist/`.
- Tests import the package by name (`@feniix/bridgekit{,/pi,/mcp}`) via Node self-referencing, so they exercise the published `exports` map. Edits aren't visible to tests until `tsc` re-emits.
- `*.typecheck.ts` files (`mcp.typecheck.ts`, `pi.typecheck.ts`) are compile-only — they fail the build if adapter type contracts regress, typically using `// @ts-expect-error` to lock in negative type assertions.
- Use `@total-typescript/shoehorn` for type-narrowing inside tests rather than ad-hoc `as` casts.

## Verify gates
`scripts/verify-bridgekit-dist.mjs` runs as part of `prepack` and enforces standalone-package invariants:
- `main`/`types`/`exports` point at built files; `engines.node` is `>=22.19.0`; `sideEffects: false`.
- No `release`, `publish`, or monorepo-relative scripts.
- MCP SDK stays on v1 (`^1.x`), TypeBox stays at `^1.1.31`.
- The string `registerMcpTools` never appears in the published JS (no high-level MCP helper).
- No dangling `sourceMappingURL` references in shipped JS.
- All documentation files (`README.md`, `llms.txt`, `examples/README.md`, `docs/extraction.md`, `docs/releasing.md`) are present.

`scripts/smoke-package.mjs` (run via `npm run package-smoke`) packs the tarball, installs it into a temp consumer, asserts the public surface, and proves that deep imports fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
