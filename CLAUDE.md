# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`@feniix/bridgekit` lets a tool author write **one** host-neutral, TypeBox-typed tool and expose it through multiple hosts (currently pi and MCP). The runtime is ESM-only and targets Node `>=22.19.0`. There is no bundler — `tsc` emits directly to `dist/`, and the published artefact is the compiled JS plus `.d.ts` files.

## Commands

All scripts are local-only; the package was extracted from a monorepo and `scripts/smoke-package.mjs` is the contract gate. See `docs/packaging-invariants.md` for the per-check catalog.

- `npm run check` — lint (`biome check .`) + `tsc -b --pretty false`. The standard pre-commit gate.
- `npm run lint:fix` — `biome check --write .`.
- `npm run build` — `clean` + `tsc -b`. Output lands at `dist/src/**`.
- `npm test` — builds, then runs Node's built-in test runner against the compiled tests (`scripts/run-built-tests.mjs` collects `dist/src/**/*.test.js`). **You must rebuild before tests will see your edits.**
- `npm run test:coverage` — same, with `--experimental-test-coverage` scoped to `dist/src/**`.
- Running a single test: after `npm run build`, invoke directly, e.g. `node --test dist/src/adapters/mcp.test.js` (or pass `--test-name-pattern "..."` to filter by name).
- `npm run pack:dry-run` — `npm pack --dry-run --json`. The `prepack` hook runs `build` automatically.
- `npm run package-smoke` — packs a tarball into a temp dir, installs it into a synthetic consumer, and asserts the public surface (`scripts/smoke-package.mjs`). Run before publishing.
- Pre-publish full gate: `npm run check && npm run test && npm run pack:dry-run && npm run package-smoke && npm audit --omit=dev --audit-level=high`.

There is intentionally **no** `release` or `publish` script — `scripts/smoke-package.mjs` will fail if one is added (see `inv-no-release-publish-scripts` in `docs/packaging-invariants.md`). See `docs/releasing.md` for the release flow.

## Architecture

### Layers

```
src/
  index.ts                  # re-exports core (definePortableTool, executePortableTool, types)
  pi.ts                     # re-exports pi adapter
  mcp.ts                    # re-exports mcp adapter
  bin-wrapper.ts            # re-exports runBinWrapper (thin delegate to bin-wrapper-internal)
  bin-wrapper-internal.ts   # internal: runBinWrapperWithDeps + dependency-injection seams (not in exports map)
  core/
    define-tool.ts    # PortableTool, PortableToolResult, PortableToolContext, host union types
    execute-tool.ts   # validatePortableToolArgs + executePortableTool
  adapters/
    pi.ts             # registerPiTools + PortableToolExecutionError
    mcp.ts            # createMcpServer + runMcpStdioServer
```

Each of the four entrypoints (`.`, `./pi`, `./mcp`, `./bin-wrapper`) maps to its own compiled file under `dist/src/`. **The split is load-bearing:** pi-only ESM/bundler consumers must not import or bundle the MCP adapter code, and MCP-only consumers must not import pi adapter code. The MCP SDK is still a normal package dependency, so npm installs include it. Do not move adapter code into the root entrypoint and do not add cross-imports between `adapters/pi.ts` and `adapters/mcp.ts`. `bin-wrapper.ts` is host-neutral packaging glue (no MCP SDK, no pi imports); its internal module ships in the tarball but is not reachable via the exports map (pinned by `inv-deep-imports-fail`).

### Core contract

`PortableToolResult` carries `text` (model-visible), optional `structuredContent` (machine-readable; preferred), optional `details` (legacy fallback), and optional `isError` (domain failure).

`executePortableTool` validates args via TypeBox `Check`/`Errors`, and on failure **returns** a result with `isError: true` — it does not throw. Adapters decide whether to surface that as a thrown exception or a structured result.

`PortableTool` carries generics for parameters and the inferred success result (`TParams extends TSchema`, `TResult extends PortableToolResult`). The host is a fixed literal union: `PortableToolBuiltInHost = "pi" | "mcp" | "test"`. `PortableToolContext.host` is typed to that union directly, so `@ts-expect-error` assertions in `execute-tool.test.ts` reject any literal outside the union (e.g. `{ host: "custom-adapter" }`). Do not reintroduce a `<THost>` generic — the audit (#5, removed in 0.10.0) confirmed no consumer used it, and the simplification is intentional.

### Adapter error behavior

- **pi adapter** defaults to returning `{ content, details, isError }` for validation failures and portable `isError: true` results. The deprecated `errorHandling: "throw"` mode still throws `PortableToolExecutionError` when `result.isError` is true. Progress maps to `onUpdate({content, details})`. `details` is sourced from `structuredContent` first, then `details`, then `{}`.
- **MCP adapter** returns `{ content, structuredContent, isError: true }` in `CallToolResult` for both invalid args and `result.isError`. Unexpected thrown exceptions are caught and surfaced as `isError: true` with the error message as text.

Both adapters prefer `structuredContent` over `details`; the latter exists only as a fallback for older callers. Result guards operate on `PortableToolResult` values at the portable seam, not directly on pi wire objects.

The MCP adapter is built on the SDK's **low-level** `Server` with explicit `ListToolsRequestSchema` / `CallToolRequestSchema` handlers, **not** the high-level `registerTool` helper. This is so TypeBox schemas pass through as MCP `inputSchema` without a JSON Schema conversion step. There is no `registerMcpTools` helper, and two layers (`scripts/smoke-package.mjs` runtime-key check + `src/adapters/mcp.test.ts` surface assertion) enforce its absence. If you think you want to add a high-level wrapper, read the rationale in `README.md` (MCP adapter section) and `docs/extraction.md` first.

### Custom-host adapters

The host union is closed: `"pi" | "mcp" | "test"`. There is no extension generic. If you ship an adapter for a host outside this union, cast `ctx.host` at the adapter boundary (the public type-system surface stays small at the cost of one cast per adapter):

```ts
// Inside your custom adapter's call site only — not in shared tool files.
const ctx: PortableToolContext = { host: "test" }; // pick the closest built-in
await executePortableTool(tool, args, ctx);
// Then inside execute(args, ctx): treat ctx.host as advisory and use a
// separate adapter-owned field for custom dispatch — exhaustive switches
// over ctx.host will fall through for cast literals.
```

For per-host metadata (advisory hints, lifecycle hooks), extend `PortableToolHostExtras` via TypeScript module augmentation rather than the host union. The `hostExtras` namespace is the canonical extension point; the host union itself is closed by design.

## Conventions

- **Modules must be import-passive.** Never register tools, start servers, read env vars, or touch the filesystem at import time. The package declares `sideEffects: false`.
- **Tool files stay host-neutral** — no pi imports, no MCP SDK imports. Host wiring lives only in adapter entrypoints.
- Tool `parameters` must resolve to a JSON-Schema object at the top level for MCP-compatible tools. `Type.Object(...)` is the common case; `Type.Intersect([Type.Object(...), Type.Object(...)])` of object schemas is also accepted. Non-object top-level schemas (`Type.String()`, `Type.Union([Type.Object(...), Type.Object(...)])`, etc.) throw at `createMcpServer` construction with a tool-attributed error. `src/adapters/mcp.typecheck.ts` pins the positive type-system fixtures; `src/adapters/mcp.test.ts` pins the runtime-guard negatives.
- Use `isError: true` for expected domain failures. Throw only for unexpected programmer/adapter/runtime errors.
- Respect `ctx.signal` in long-running tools; emit progress via `ctx.progress?.(...)`.
- **ESM internal imports use `.js` extensions** even though the source is `.ts` (NodeNext resolution): `from "./define-tool.js"`.
- Consumers must use only the four public entrypoints — never deep-import from `dist/` or `src/`. The smoke test asserts `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@feniix/bridgekit/dist/...`.
- For downstream examples/docs that expose MCP stdio through npm `bin` and depend on generated output, use the built-in `runBinWrapper` from `@feniix/bridgekit/bin-wrapper` (since 0.11.0). The helper resolves the package-local generated server, runs the package-local build for workspace/local execution when missing, preserves build failures, and distinguishes build-timeout from build-failure in its diagnostic. `mcpEntry` and `buildScript` must be literal strings — sourcing them from CLI args or env vars is outside the supported threat model even though bridgekit rejects absolute/traversing entry paths and shell-shaped script names. MCP stdio bins should pass `buildStdio: ["ignore", "inherit", "inherit"]`. Verify the bin script's executable mode via `npm pack --dry-run --json`.
- Biome (`biome.json`) is the only formatter/linter. Enforced rules of note: `noExplicitAny`, `noNonNullAssertion`, `noUnusedImports`. TypeScript is strict-plus (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Two-space indent, 120-col, double quotes, semicolons.
- `PortableTool.hostExtras` is the canonical place for per-host metadata (0.9+). Tool definitions stay host-neutral; host-specific concerns (pi's `pendingMessage` / `promptSnippet` / `promptGuidelines`, MCP's `annotations`) live in the corresponding `hostExtras.<host>` namespace. Adding host-specific fields directly to `PortableTool`'s top-level shape is wrong — extend `PortableToolHostExtras` instead (via TypeScript module augmentation for custom-host adapters). Each adapter's read path must gate on `!== undefined` so tools without `hostExtras` produce byte-identical wire payloads to pre-0.9 versions; pin with a no-hostExtras key-set assertion alongside any new field.

## Tests

- The test runner is **Node's built-in `--test`** (not vitest/jest). Tests are written in TS under `src/`, compiled to `dist/src/`, and executed from there.
- Tests import the package by name (`@feniix/bridgekit`, `@feniix/bridgekit/pi`, `@feniix/bridgekit/mcp`) using Node self-referencing — this exercises the real `exports` map. The corollary: a fresh source edit is invisible to tests until `tsc` re-emits.
- File naming and packaging behaviour:
  - `*.test.ts` — runtime tests, executed by `npm test`.
  - `*.integration.test.ts` — also picked up by the same runner (the glob is `*.test.js`); no separate command.
  - `*.typecheck.ts` — compile-only fixtures, typically loaded with `// @ts-expect-error` to lock in negative type assertions; never executed.
  - All three patterns plus `.map` files are excluded from the published tarball via `package.json#files`.
- Use `@total-typescript/shoehorn` for type-narrowing in tests rather than ad-hoc `as` casts.

## Things not to do

- Do not deep-import from `dist/` or `src/` in tests, examples, or docs — use the package entrypoints.
- Do not collapse the four entrypoints into a single barrel — pi-only consumers must not import or bundle the MCP adapter, and the bin-wrapper's `node:child_process` import must stay out of library-only consumers.
- Do not add a high-level `registerMcpTools` helper without first proving SDK compatibility; `scripts/smoke-package.mjs` and `src/adapters/mcp.test.ts` both enforce its absence.
- Do not throw inside `executePortableTool` for validation failures — return `isError: true`. The adapters convert as needed.
- Do not add `workspace:` or `file:` dependency ranges, or `release`/`publish` scripts to `package.json`. `scripts/smoke-package.mjs` will fail.
- Do not ship `sourceMappingURL` comments without their maps. Source maps are off for builds (`tsconfig.json` has `sourceMap: false`) and `scripts/smoke-package.mjs` re-asserts this.
- Do not register tools or start servers at module top-level — always inside an exported function the host calls explicitly.

## Read order for deeper context

1. `README.md` — public API, contracts, packaging.
2. `llms.txt` — compact agent-facing usage rules and anti-patterns.
3. `examples/README.md` — copyable layouts for shared tools, pi extension, MCP server, hostExtras.
4. `dist/src/*.d.ts` (after build) — canonical installed-package type contracts. In a source checkout the matching `src/` files carry the same context.
5. `docs/extraction.md` / `docs/releasing.md` — historical rationale and future release handoff.
6. `docs/solutions/` — documented learnings from prior problems (architecture patterns, bug fixes, design decisions), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
