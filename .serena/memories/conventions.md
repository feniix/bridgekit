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
- `mcp.typecheck.ts` exists to fail the build if MCP-adapter type contracts regress.
