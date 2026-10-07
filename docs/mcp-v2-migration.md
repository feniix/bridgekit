# MCP SDK v2 migration (#117)

## Decision

Use SDK v2's low-level `Server`, preserving TypeBox JSON Schema passthrough.
Upgrade the existing `runMcpStdioServer` to dual-era `serveStdio` serving, rather
than introducing another public runner or entrypoint. The original migration
preserved `Promise<void>`. The upcoming #129 change returns
`Promise<McpStdioServerHandle>` with idempotent `close(): Promise<void>` to close
the transport and abort in-flight requests. Resolution means startup wiring is
installed, not that negotiation has completed or shutdown has occurred.
Explicit `Promise<void>` annotations must be updated; callers that ignore the
resolved value need no changes. Stdin EOF still triggers cleanup.
The SDK closes stdio on EOF; tools must respect their cancellation signal and
must not leave unrelated processes/timers running.

Each discovery probe/connection gets a fresh server, so discarded modern probes
cannot contaminate legacy fallback handlers. Opening/transport errors reported
by the SDK are diagnosed on stderr with a `[bridgekit-mcp]` prefix, never stdout.
The SDK exposes no readiness promise: runner resolution means wiring completed,
not that an asynchronous transport start or negotiation succeeded. The close
handle permits explicit teardown in addition to stdin EOF.

`createMcpServer` validates and constructs a passive SDK v2 `Server`. Connecting
it directly with a `StdioServerTransport` still serves only the legacy era.
Use the public runner to enable modern revision `2026-07-28`.

## Streamable HTTP decision (#126)

Ship `createMcpHttpHandler(options, httpOptions?)` under `./mcp`, composing
the SDK's Web-standard handler with `createMcpServer`. It validates definitions
eagerly and creates fresh servers per SDK request. The returned SDK handler has
`fetch`, `close`, `notify`, and `bus`; SDK HTTP options pass through unchanged.
The default legacy leg is stateless. No Node HTTP listener code enters the
library. Applications own auth, authorization, Host/Origin checks, CORS, TLS,
and listener lifecycle. See the README recipe. Source integration tests use a
real loopback listener for both eras; packed-consumer tests use both eras over
the Web-standard HTTP transport.

## Breaking-change policy

Ship this as pre-1.0 **minor** release `0.16.0`. The returned `Server`
type/object changes, even though
legacy clients remain interoperable on the wire.

Consumers using `createMcpServer` beyond the public runner must:

- Replace v1 imports with `@modelcontextprotocol/server` (transports from `/stdio`).
- Register `"tools/list"` / `"tools/call"` strings instead of v1 schema constants.
- Read `ctx.mcpReq.signal` instead of `extra.signal`.
- Avoid mixing SDK v1 instances/transports/types with SDK v2 objects.

The v1 SDK remains a development-only dependency intentionally (#131). The v2
client's legacy mode already covers legacy wire interoperability, but cannot pin
v1's client-specific success-schema validation of domain errors or the generic
request workaround described below. The v1 stdio test covers both; retaining it
keeps that migration guidance executable. Reconsider this dependency when that
v1 compatibility guidance is retired, not merely when legacy wire coverage changes.
The v2 client is also test-only. Runtime code imports only the v2 server package.

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
fails the call. Known client limitation: the official SDK clients (v1 and v2)
dispatch notification handlers on a microtask while responses are handled
synchronously, so a synchronous burst of updates immediately followed by the
result can be dropped client-side when it lands in one stdio chunk. The wire
order is correct (pinned by the raw stdio test); spaced updates are delivered.
Upstream: [typescript-sdk#2580](https://github.com/modelcontextprotocol/typescript-sdk/issues/2580), fix pending in
[typescript-sdk#2967](https://github.com/modelcontextprotocol/typescript-sdk/pull/2967);
tracked in [#132](https://github.com/feniix/bridgekit/issues/132).

## Verification and scope

Regression seams: portable execution, Pi registration/results, MCP connected pairs,
spawned legacy/v2-modern stdio clients, cancellation through the public tool seam,
EOF shutdown, and installed tarball declarations/protocol calls.

HTTP/auth, tasks, resources/prompts, and additional Pi metadata were out of scope
for the original SDK migration. The upcoming backlog pass adds HTTP serving
(#126), MCP tool metadata (#128), and stdio lifecycle control (#129); auth and
listener policy remain application-owned. Tasks (#127) remain in progress.
Passing the project tests is not an official conformance claim.

Research and isolated evidence: [research/mcp-protocol-v2.md](research/mcp-protocol-v2.md).
The official suite's HTTP-only server invocation currently blocks direct stdio
conformance testing; see [research/mcp-stdio-conformance.md](research/mcp-stdio-conformance.md)
for the checked CLI version, evidence, and follow-up criteria (#130).
