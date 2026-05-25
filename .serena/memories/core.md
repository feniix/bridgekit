# Project Core — @feniix/bridgekit

Define one TypeBox-typed, host-neutral tool; expose via multiple host adapters (pi, MCP, custom). ESM-only, `tsc` straight to `dist/`, no bundler.

## Source map

```
src/
  index.ts            # public: definePortableTool, executePortableTool, types
  pi.ts               # public: pi adapter re-export
  mcp.ts              # public: mcp adapter re-export
  core/
    define-tool.ts    # PortableTool, PortableToolResult, PortableToolContext, host union
    execute-tool.ts   # validatePortableToolArgs + executePortableTool
  adapters/
    pi.ts             # registerPiTools + PortableToolExecutionError
    mcp.ts            # createMcpServer + runMcpStdioServer (low-level SDK Server)
    mcp-signal.ts     # signalFromExtra: AbortSignal from MCP request extras
```

Three public entrypoints (`.`, `./pi`, `./mcp`) — load-bearing split. pi-only consumers must not pull MCP SDK. No cross-imports between `adapters/pi.ts` and `adapters/mcp.ts`.

## Project-wide invariants

- Modules import-passive: `sideEffects: false`. No registration, server start, env reads, or fs touches at import time. Tool/server wiring inside an exported function only.
- Tool files host-neutral: no pi/MCP imports outside `adapters/`.
- `PortableToolResult`: `text` (model-visible), `structuredContent` (preferred, machine-readable), `details` (legacy fallback), `isError` (domain failure).
- `executePortableTool` validates with TypeBox `Check`/`Errors`; on failure **returns** `isError: true` — never throws for validation. Adapters decide whether to throw.
- Host generic: `PortableTool<TParams, THost>` uses `NoInfer<THost>` inside `executePortableTool` so host type comes from the tool definition, not `ctx`. Locked in by `src/core/result-generic.typecheck.ts`. Removing `NoInfer` silently breaks host narrowing.
- MCP adapter uses SDK **low-level `Server`** with explicit `ListToolsRequestSchema` / `CallToolRequestSchema`. No high-level `registerTool` — so TypeBox schemas pass through as `inputSchema` without JSON Schema conversion. Two layers enforce absence: `scripts/smoke-package.mjs` runtime-key check + `src/adapters/mcp.test.ts` surface assertion.
- Adapter asymmetry (intentional): pi **throws** `PortableToolExecutionError` on `isError`; MCP **returns** `{ content, structuredContent, isError: true }`.
- Default host union: `"pi" | "mcp" | "test"`. Extend via second generic on `definePortableTool<typeof params, "custom-runtime">`.
- ESM internal imports use `.js` extension on `.ts` source (NodeNext): `from "./define-tool.js"`.
- Consumers must use the three entrypoints only — never deep-import from `dist/` or `src/`. Enforced by smoke test (`ERR_PACKAGE_PATH_NOT_EXPORTED` for `@feniix/bridgekit/dist/...`).
- `Type.Object(...)` required for MCP-compatible tools (constraint on `createMcpServer`'s `tools` parameter; `mcp.typecheck.ts` locks via `@ts-expect-error`).
- Downstream MCP-stdio bin: prefer a checked-in `bin/` wrapper resolving package-local generated server over pointing at `dist/`. Executable mode verified by `npm pack --dry-run --json`.

## Domain references

- Tech stack and version pins: `mem:tech_stack`.
- Commands the user actually runs: `mem:suggested_commands`.
- Code style, naming, file/test naming conventions: `mem:conventions`.
- Done-criteria gate (pre-commit / pre-publish): `mem:task_completion`.

## External anchors

- `README.md` — public API and contracts.
- `llms.txt` — compact agent-facing usage rules.
- `examples/README.md` — copyable layouts (shared tool, pi extension, MCP server, custom host).
- `docs/packaging-invariants.md` — per-check catalog enforced by `scripts/smoke-package.mjs`.
- `docs/extraction.md`, `docs/releasing.md` — historical rationale, release flow.
- `dist/src/*.d.ts` after build — canonical installed-package contracts.
