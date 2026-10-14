# MCP SDK v2 migration (#117)

## Decision

Use SDK v2's low-level `Server`, preserving TypeBox JSON Schema passthrough.
Upgrade the existing `runMcpStdioServer` to `serveStdio` serving, rather than
introducing another public runner or entrypoint. Legacy-era (`2025-11-25`)
serving was dropped afterwards: see "Dropping legacy-era serving" below. The original migration
preserved `Promise<void>`. The #129 lifecycle change returns
`Promise<McpStdioServerHandle>` with idempotent `close(): Promise<void>` to close
the transport and abort in-flight requests. Resolution means startup wiring is
installed, not that negotiation has completed or shutdown has occurred.
Explicit `Promise<void>` annotations must be updated; callers that ignore the
resolved value need no changes. `close()` aborts requests but does not await
handler completion or asynchronous cleanup: consumers must coordinate tool
cleanup before disposing shared application resources. Stdin EOF still triggers cleanup.
The SDK closes stdio on EOF; tools must respect their cancellation signal and
must not leave unrelated processes/timers running.

Each discovery probe/connection gets a fresh server, so discarded modern probes
cannot contaminate later connections. Opening/transport errors reported
by the SDK are diagnosed on stderr with a `[bridgekit-mcp]` prefix, never stdout.
The SDK exposes no readiness promise: runner resolution means wiring completed,
not that an asynchronous transport start or negotiation succeeded. The close
handle permits explicit teardown in addition to stdin EOF.

`createMcpServer` validates and constructs a passive SDK v2 `Server` and is
deprecated. Connecting it directly with a `StdioServerTransport` serves only the
legacy era, which BridgeKit no longer supports; use the public runner or the
HTTP handler for modern revision `2026-07-28`.

## Streamable HTTP decision (#126)

Ship `createMcpHttpHandler(options, httpOptions?)` under `./mcp`, composing
the SDK's Web-standard handler with `createMcpServer`. It validates definitions
eagerly and creates fresh servers per SDK request. The returned SDK handler has
`fetch`, `close`, `notify`, and `bus`; SDK HTTP options pass through unchanged.
Legacy-era requests are rejected (`legacy: "reject"`). No Node HTTP listener
code enters the library. Applications own auth, authorization, Host/Origin
checks, CORS, TLS, and listener lifecycle. See the README recipe. Source
integration tests use a real loopback listener; packed-consumer tests use the
Web-standard HTTP transport.

## Dropping legacy-era serving

BridgeKit serves only the modern `2026-07-28` era over stdio and HTTP. The
SDK's `legacy: "reject"` mode answers `2025-11-25` openings with
`-32022` (unsupported protocol version, `data.supported: ["2026-07-28"]`);
the stdio connection stays open for a modern opening.

Consumer impact:

- Clients limited to `2025-11-25` (SDK v1, or v2 `versionNegotiation.mode:
  "legacy"`) can no longer connect.
- The SDK v2 client's default negotiation opens with `2025-11-25`; pin
  `{ mode: { pin: "2026-07-28" } }` or use `"auto"`.
- `CreateMcpHttpHandlerOptions` no longer accepts `legacy`.
- `createMcpServer` is deprecated; a directly connected `Server` is legacy-only.
- Non-object output roots are no longer wrapped as `{ result }` for any served
  client; modern clients receive the natural value.

The SDK v1 dev dependency and its interop test were removed with this change; the
#131 v1-client workaround notes below are retained as historical context only.

## Breaking-change policy

Ship this as pre-1.0 **minor** release `0.16.0`. The returned `Server`
type/object changes, even though
legacy clients are no longer served (see "Dropping legacy-era serving").

Consumers using `createMcpServer` beyond the public runner must:

- Replace v1 imports with `@modelcontextprotocol/server` (transports from `/stdio`).
- Register `"tools/list"` / `"tools/call"` strings instead of v1 schema constants.
- Read `ctx.mcpReq.signal` instead of `extra.signal`.
- Avoid mixing SDK v1 instances/transports/types with SDK v2 objects.

The v1 SDK is no longer a dependency (#131 retired with legacy serving). The v2
client is test-only. Runtime code imports only the v2 server package.

## Structured output

`PortableTool.outputSchema` is optional TypeBox JSON Schema with any root except a
top-level `$ref`. Objects, object intersections, arrays, primitives, `null` and
unions are accepted. All-object intersections are lowered to `type: "object"` for
MCP listing and projection, because the SDK's legacy `{ result }` wrap keys on the
advertised root `type`; every other root passes through by reference and
`projectCallToolResult` wraps the listed schema and the value as `{ result }` on
the 2025 era while modern clients receive the natural value. Pi forwards the raw
value and wraps non-object values as `details.result`.

Successful tools declaring a schema must return matching `structuredContent`;
legacy `details` alone does not satisfy that contract. Contract violations throw
a tool-attributed `TypeError` from portable execution; adapters surface a failed
tool result (Pi's deprecated throw mode rethrows).

Argument/domain failures are exempt from success schemas and retain their error
data. SDK v2 clients support that exemption. SDK v1's convenience `callTool` can
still validate error structured data against a cached success schema; consumers
of that SDK may need its generic request API to read such error data. Do not drop
portable failure details to work around that client behavior.

Pi forwards both `outputSchema` and result `structuredContent`, retaining the old
renderer-facing `details` precedence/fallback. Fields not supplied remain omitted.

`definePortableTool` checks successful structured data against the inferred schema
at compile time, including async results, while retaining inferred handler unions.
Domain failures use the literal `isError: true` discriminator. Explicit annotations
can use `PortableTool<TParams, TResult, TOutput>`; existing two-generic annotations
erase schema specificity. Runtime validation remains necessary for JavaScript,
untyped data, and refinements not represented by TypeScript (e.g. numeric bounds).
Explicit legacy `definePortableTool<TParams, TResult>(...)` calls are another
intentional schema-erasure boundary, even with a concrete schema. Prefer inferred
calls for compile-time checking; explicit calls still receive runtime validation.
Metadata decoration and already-annotated/schema-erased tool inputs remain
supported. Listings retain schema references while execution reads the tool:
both `parameters` and `outputSchema` are immutable after registration, including
replacing either schema object.

MCP output-schema construction errors remain `TypeError`s with the stable code
`BRIDGEKIT_MCP_REF_OUTPUT_SCHEMA` and a `createMcpServer:` prefix; the former
`BRIDGEKIT_MCP_NON_OBJECT_OUTPUT_SCHEMA` code no longer exists because non-object
roots are accepted.

## Progress notifications

`ctx.progress` is wired on MCP only when the request carried `_meta.progressToken`.
Each update sends `notifications/progress` with the token, a per-call counter
starting at 1 as `progress`, and `update.text` as `message`; `total` is omitted and
no numeric convention is read from `structuredContent`. Sends are awaited before
the result and skipped once `ctx.mcpReq.signal` is aborted; a failed send never
fails the call. Known client limitation: the official SDK clients
dispatch notification handlers on a microtask while responses are handled
synchronously, so a synchronous burst of updates immediately followed by the
result can be dropped client-side when it lands in one stdio chunk. The wire
order is correct (pinned by the raw stdio test); spaced updates are delivered.
Upstream: [typescript-sdk#2580](https://github.com/modelcontextprotocol/typescript-sdk/issues/2580), fix pending in
[typescript-sdk#2967](https://github.com/modelcontextprotocol/typescript-sdk/pull/2967);
tracked in [#132](https://github.com/feniix/bridgekit/issues/132).

## Verification and scope

Regression seams: portable execution, Pi registration/results, MCP connected pairs,
spawned v2-modern stdio clients and legacy-rejection, cancellation through the public tool seam,
EOF shutdown, and installed tarball declarations/protocol calls.

HTTP/auth, tasks, resources/prompts, and additional Pi metadata were out of scope
for the original SDK migration. The backlog pass adds HTTP serving
(#126), MCP tool metadata (#128), and stdio lifecycle control (#129); auth and
listener policy remain application-owned. Tasks (#127) have an approved design; implementation is pending.
Passing the project tests is not an official conformance claim.

Research and isolated evidence: [research/mcp-protocol-v2.md](research/mcp-protocol-v2.md).
The official suite's HTTP-only server invocation currently blocks direct stdio
conformance testing; see [research/mcp-stdio-conformance.md](research/mcp-stdio-conformance.md)
for the checked CLI version, evidence, and follow-up criteria (#130).
