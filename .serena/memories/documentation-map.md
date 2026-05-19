# Documentation map

When investigating something, prefer these in order:

1. **`README.md`** — public API surface, entrypoints, tool-authoring best practices, packaging checklist.
2. **`llms.txt`** — compact agent-facing usage rules and anti-patterns. Read this before generating any consumer code.
3. **`examples/README.md`** — copyable layouts for: shared tool modules, pi extensions, MCP stdio servers, custom hosts.
4. **`docs/extraction.md`** — notes on how the package was extracted (history/rationale for the current shape).
5. **`docs/releasing.md`** — future release handoff (publish flow not yet automated).
6. **Published declarations** — `dist/src/index.d.ts`, `dist/src/pi.d.ts`, `dist/src/mcp.d.ts` are the canonical installed-package type contracts. In a source checkout the matching files under `src/` carry the same context.

There is **no** consumer-facing high-level MCP `registerMcpTools` helper — this is intentional (low-level handlers preserve TypeBox schemas as-is). Don't suggest adding one without first reading the rationale in `README.md` (MCP adapter section) and `docs/extraction.md`.
