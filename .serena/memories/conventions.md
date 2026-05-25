# Conventions — @feniix/bridgekit

## Import / module shape

- ESM only. `type: "module"`. `sideEffects: false`.
- Internal imports use `.js` on `.ts` source: `from "./define-tool.js"` (NodeNext).
- No side effects at import time: no tool registration, server start, env reads, fs touches. All wiring inside exported functions.
- Tool source files stay host-neutral: no pi imports, no MCP SDK imports. Host wiring lives only in adapter entrypoints (`src/adapters/`).
- No deep imports from `dist/` or `src/` in tests, examples, or docs — only the three public entrypoints.
- No cross-imports between `adapters/pi.ts` and `adapters/mcp.ts`.

## Tool authoring

- `Type.Object(...)` is required for MCP compat (constraint on `createMcpServer`). For pi-only tools, other TypeBox shapes are accepted but `Type.Object` is the default.
- Use `isError: true` for expected domain failures. **Throw** only for unexpected programmer/adapter/runtime errors.
- Prefer `structuredContent` over `details` in results. `details` exists only as a fallback for older callers.
- Respect `ctx.signal` in long-running tools. Emit progress via `ctx.progress?.(...)`.
- For custom hosts, opt in at definition: `definePortableTool<typeof params, "custom-runtime">(...)`. `PortableToolHost<"custom-runtime">` is the union of built-ins + extension.

## Lint / format

- Biome only (no eslint/prettier). Two-space indent, 120-col, double quotes, semicolons.
- Enforced: `noExplicitAny`, `noNonNullAssertion`, `noUnusedImports`.

## Test naming and packaging

- `*.test.ts` — runtime tests, executed by `npm test`.
- `*.integration.test.ts` — also picked up (glob is `*.test.js`); no separate command.
- `*.typecheck.ts` — compile-only fixtures, typically `// @ts-expect-error` to lock negative type assertions. Never executed.
- All three patterns plus `.map` files excluded from the published tarball via `package.json#files`.
- Use `@total-typescript/shoehorn` for type narrowing in tests instead of ad-hoc `as` casts.

## Things not to do

- Do **not** add a high-level `registerMcpTools` helper. The low-level `Server` is load-bearing (avoids JSON Schema conversion). Two layers enforce absence: smoke-test runtime-key check + `src/adapters/mcp.test.ts` surface assertion. Read `README.md` MCP-adapter section and `docs/extraction.md` first if tempted.
- Do **not** collapse the three entrypoints into a single barrel.
- Do **not** throw inside `executePortableTool` for validation failures — return `isError: true`.
- Do **not** add `workspace:`/`file:` ranges or `release`/`publish` scripts to `package.json`.
- Do **not** ship `sourceMappingURL` comments without maps (smoke test re-asserts `sourceMap: false`).
- Do **not** remove the `NoInfer<THost>` wrap in `executePortableTool`'s signature — it makes host typing come from the tool definition rather than `ctx`.
