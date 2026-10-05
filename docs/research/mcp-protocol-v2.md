# Research: MCP protocol v2 and BridgeKit adoption

## Summary

There does **not** appear to be an official MCP protocol named “v2.” The important distinction today is between date-versioned MCP protocol revisions/eras: the 2025 “legacy” era through `2025-11-25`, and the newer `2026-07-28` “modern” era; “v2” primarily refers to the TypeScript SDK package line. BridgeKit’s current MCP adapter is a 2025-era, stdio-only, low-level-server implementation; supporting the modern target would require an SDK v2 migration plus explicit modern serving entrypoints and some BridgeKit API additions.

## Findings

1. **Claim:** “MCP protocol v2” is not the official protocol name; MCP protocol versions are date-versioned revisions/eras. **Sources:** [MCP TypeScript SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions), [SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md). **Support:** direct evidence. **Confidence:** high.  
   The SDK docs call `2024-10-07` through `2025-11-25` the `legacy` era and `2026-07-28` the `modern` era. The migration guide says v1 `@modelcontextprotocol/sdk` migrates to v2 packages, while protocol `2026-07-28` is a separate opt-in target.

2. **Claim:** BridgeKit currently targets the 2025-era MCP model. **Sources:** local `package.json`, local `src/adapters/mcp.ts`, [SDK v2 protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions). **Support:** interpretation. **Confidence:** high.  
   BridgeKit depends on `@modelcontextprotocol/sdk` v1 range and uses `Server`, `StdioServerTransport`, `ListToolsRequestSchema`, and `CallToolRequestSchema`. The SDK v2 docs say direct `server.connect(new StdioServerTransport())` is the 2025-era stdio entry, while modern stdio uses `serveStdio(factory)`.

3. **Claim:** BridgeKit already preserves MCP `structuredContent`, but lacks tool `outputSchema` declaration/validation and has too-narrow structured result typing for the modern direction. **Sources:** [2025-11-25 tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [2026-07-28 RC blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), local `src/core/define-tool.ts`, local `src/adapters/mcp.ts`. **Support:** direct evidence + interpretation. **Confidence:** high.  
   The spec defines optional `outputSchema`; if present, servers must return conforming structured results and clients should validate. The 2026 RC says output schemas are unrestricted JSON Schema 2020-12 and `structuredContent` can be any JSON value. BridgeKit has `structuredContent?: Record<string, unknown>` and no `outputSchema` field on `PortableTool`.

4. **Claim:** BridgeKit supports basic tool annotations but not newer tool execution/task metadata. **Sources:** [2025-11-25 tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), [Tasks extension draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks), local `src/core/define-tool.ts`, local `src/adapters/mcp.ts`. **Support:** interpretation. **Confidence:** high.  
   BridgeKit passes `hostExtras.mcp.annotations` into `tools/list`. It does not emit `icons`, `execution.taskSupport`, task handles, or handlers for `tasks/get`, `tasks/update`, or `tasks/cancel`.

5. **Claim:** Modern MCP adoption is explicit; upgrading SDK packages alone will not make BridgeKit serve `2026-07-28`. **Sources:** [Supporting protocol revision 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions). **Support:** direct evidence. **Confidence:** high.  
   The SDK says hand-constructed `Client`/`Server`/`McpServer` keep speaking the 2025-era protocol by default. Modern HTTP uses `createMcpHandler`; modern stdio uses `serveStdio(factory)`.

6. **Claim:** BridgeKit lacks Streamable HTTP support and therefore lacks HTTP-specific modern/legacy transport behavior. **Sources:** [2025-11-25 transports spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [2026-07-28 RC blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), local `src/adapters/mcp.ts`. **Support:** direct evidence + interpretation. **Confidence:** high.  
   BridgeKit exposes only `runMcpStdioServer`. The spec defines Streamable HTTP, session headers, `MCP-Protocol-Version`, SSE resumability, and security requirements. The 2026 direction removes protocol sessions and uses routable headers such as `Mcp-Method`/`Mcp-Name`.

7. **Claim:** SDK v2 migration has breaking API/package implications for BridgeKit. **Sources:** [v1-to-v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md). **Support:** direct evidence. **Confidence:** high.  
   The monolithic `@modelcontextprotocol/sdk` package is split into `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/core`. Low-level `setRequestHandler(Schema, …)` changes to method strings; `RequestHandlerExtra` becomes `ServerContext`; schema constants move.

## Recommended adoption plan

1. **Clarify target language:** avoid “MCP protocol v2” in BridgeKit docs/API. Use “MCP SDK v2” and “MCP `2026-07-28` / modern era.”
2. **Stage 1 — 2025-era completeness:** add optional `outputSchema` to `PortableTool`, pass it through `tools/list`, and optionally validate `structuredContent`; widen structured result typing from object-only to JSON-value-compatible if desired.
3. **Stage 2 — SDK v2 migration while preserving behavior:** migrate imports/packages and low-level handler registration, but keep stdio legacy behavior as default to avoid surprising existing consumers.
4. **Stage 3 — modern opt-in:** expose a new modern-capable stdio runner backed by `serveStdio(factory)`; consider an HTTP entrypoint backed by `createMcpHandler` only if BridgeKit wants to own HTTP hosting/security concerns.
5. **Stage 4 — tasks/execution:** defer full task support until BridgeKit has a clear async execution abstraction. Do not advertise task support without implementing the corresponding runtime behavior.
6. **Stage 5 — tests/conformance:** add adapter tests for `outputSchema`, SDK v2 handler wiring, legacy stdio compatibility, and modern opt-in behavior.

## Contradictions

- **No direct contradiction found** on protocol naming: official docs consistently use date-versioned protocol revisions/eras, while SDK docs use “v2” for package/API migration.
- **Potential confusion:** `2025-11-25` includes experimental tasks in core, while newer material moves tasks to an extension. BridgeKit should not treat “tasks” as one stable API across revisions.

## Missing evidence

- I did not verify BridgeKit against the official MCP conformance suite.
- I did not inspect every SDK v2 type that BridgeKit would need after migration.
- Local `node_modules/@modelcontextprotocol/sdk/package.json` showed `1.29.0`, while project `package.json` declares `^1.30.1`; lock/install state may be stale.

## Sources

- Kept: MCP TypeScript SDK Protocol versions (https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions) — best source for era/version model.
- Kept: SDK v1-to-v2 migration guide (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md) — package/API migration impact.
- Kept: Supporting protocol revision 2026-07-28 (https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) — explicit modern opt-in requirements.
- Kept: MCP 2025-11-25 Tools spec (https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — outputSchema, structuredContent, execution metadata.
- Kept: MCP 2025-11-25 Transports spec (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) — stdio/Streamable HTTP details.
- Kept: 2026-07-28 release-candidate blog (https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) — modern-era direction and breaking changes.
- Kept: Tasks extension draft (https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks) — current task model.
- Rejected/deprioritized: Search-result summaries and third-party commentary — used only for discovery, not final evidence.

## Next steps

The code-focused spike is complete; see the verified results below. No production dependency or public API changes have been made.

## Verified code spike — 2026-10-05

### Environment and reproducible evidence

- Installed published `@modelcontextprotocol/server@2.3.1` and
  `@modelcontextprotocol/client@2.3.1` in an isolated temporary directory.
- Installed `@modelcontextprotocol/sdk@1.30.1` there solely for legacy-client interoperability.
- Used BridgeKit's built public root entrypoint (`definePortableTool`, `executePortableTool`),
  TypeBox `1.1.31`, TypeScript `6.0.3`, and Node's built-in test runner.
- Compiled with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`;
  dependency declaration checking was skipped (`skipLibCheck`).
- Preserved the three spike source files in [mcp-v2-spike/](./mcp-v2-spike/).
  They are experiments, not part of BridgeKit's shipped API or standard test suite.
- Result: **6 tests passed, 0 failed**.

| Test | Observed outcome |
| --- | --- |
| SDK v2 default client → `serveStdio` | Legacy era; TypeBox schema listing, execution, validation failure, unknown-tool error |
| SDK v2 automatic negotiation → `serveStdio` | Modern era; same portable execution/validation |
| SDK v2 pinned `2026-07-28` → `serveStdio` | Modern era; same portable execution/validation |
| SDK v1 `1.30.1` client → `serveStdio` | Listing and execution work; array output schema/result adapted to legacy object wrapper |
| Modern-pinned client → direct `Server.connect(StdioServerTransport)` | Connect rejects; direct connection alone does not enable modern serving |
| Legacy client → `serveStdio(..., { legacy: "reject" })` | Connect rejects |

The first three tests also verify native array structured output on modern connections
and `{ result: [...] }` output on legacy connections. The array fixture deliberately
bypasses BridgeKit's current object-only portable result typing; it tests SDK behavior,
not an already-supported portable feature.

### Concrete migration findings

1. **Keep the low-level adapter.** `serveStdio` accepts a factory returning the low-level
   `Server`, not only `McpServer`. No high-level tool registration helper or TypeBox-to-Zod
   conversion is needed. Verified by compilation and spawned stdio tests.
2. **Runtime dependencies can stay small.** The spike adapter imports only
   `@modelcontextprotocol/server` and its `/stdio` subpath. Shared `Tool`, `CallToolResult`,
   and context types are available from that package. `@modelcontextprotocol/client`
   is needed for tests; `@modelcontextprotocol/core` is not required unless code explicitly
   imports raw SDK validators. See the [v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md).
3. **Change handlers and cancellation paths.** Register `"tools/list"` / `"tools/call"`
   strings, not v1 schema constants, and read `ctx.mcpReq.signal`. Tests verified that an
   AbortSignal reaches portable execution, but did not test in-flight cancellation.
4. **Retain the schema boundary.** Direct assignment of a TypeBox `TObject` to SDK v2's
   `Tool["inputSchema"]` failed strict compilation because nested schema types lack the
   SDK's JSON index signatures. The same adapter-local boundary cast used by BridgeKit
   today compiles. Keep runtime object-root checks and intersection lowering rather than
   interpreting this as a reason to weaken portable schema typing.
5. **Project low-level tool results explicitly.** SDK v2 documents
   `server.projectCallToolResult(result, advertisedOutputSchema)` for low-level
   `tools/call` authors. It handles structured-result text projection and legacy
   object wrapping for non-object output schemas/results. The spike verifies array
   schema/result interoperability. See the
   [published source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/server.ts)
   and installed `Server` declaration.
6. **An extra public runner is not technically necessary.** `serveStdio` already serves
   both eras by default. Whether to upgrade `runMcpStdioServer` in place or add a separate
   runner is a public API/product decision, not an SDK limitation. Its return value is
   a synchronous handle with async `close()`, unlike BridgeKit's existing `Promise<void>`
   runner; preserve the old signature unless deliberately changing it.
7. **Migration is still a source-level breaking change.** `createMcpServer` publicly
   returns an SDK v1 `Server`. Replacing it with SDK v2 changes the objects consumers
   receive, even if legacy wire interoperability remains intact.
8. **Update packaging gates deliberately.** `scripts/smoke-package.mjs` explicitly pins
   the v1 SDK package/range. Migration must update that assertion, the catalog in
   `docs/packaging-invariants.md`, and SDK fixtures/tests—not simply remove the check.

### Recommendation after the spike

Migrate the MCP adapter to SDK v2's low-level `Server` and use `serveStdio` for modern
serving with legacy interoperability. Start with existing object-shaped portable tools:
neither tasks nor HTTP nor non-object structured output is required to serve the modern
protocol. Add portable output schemas and broader JSON results as separately scoped
enhancements, using SDK result projection for legacy compatibility.

Before implementation, settle the `createMcpServer` breaking-change policy and whether
the existing runner should become dual-era or a new runner should be exposed. Expand
integration coverage to domain errors, thrown exceptions, actual cancellation,
intersections, lifecycle/close behavior, and packed consumer tests. No official
conformance suite or HTTP/auth/task implementation was exercised by this spike.
