# MCP SDK v2 migration (#117)

## Decision

Use SDK v2's low-level `Server`, preserving TypeBox JSON Schema passthrough.
Upgrade the existing `runMcpStdioServer` to dual-era `serveStdio` serving, rather
than introducing another public runner or entrypoint. The runner still returns
`Promise<void>` once startup is wired; it does not wait for EOF or return a close handle.
The SDK closes stdio on EOF; tools must respect their cancellation signal and
must not leave unrelated processes/timers running.

Each discovery probe/connection gets a fresh server, so discarded modern probes
cannot contaminate legacy fallback handlers. Opening/transport errors reported
by the SDK are diagnosed on stderr with a `[bridgekit-mcp]` prefix, never stdout.
The SDK exposes no readiness promise: runner resolution means wiring completed,
not that an asynchronous transport start or negotiation succeeded. A close handle
is intentionally not exposed by the existing `Promise<void>` API.

`createMcpServer` validates and constructs a passive SDK v2 `Server`. Connecting
it directly with a `StdioServerTransport` still serves only the legacy era.
Use the public runner to enable modern revision `2026-07-28`.

## Breaking-change policy

Ship this as the next pre-1.0 **minor** release. No version bump is made as part
of implementation. The returned `Server` type/object changes, even though
legacy clients remain interoperable on the wire.

Consumers using `createMcpServer` beyond the public runner must:

- Replace v1 imports with `@modelcontextprotocol/server` (transports from `/stdio`).
- Register `"tools/list"` / `"tools/call"` strings instead of v1 schema constants.
- Read `ctx.mcpReq.signal` instead of `extra.signal`.
- Avoid mixing SDK v1 instances/transports/types with SDK v2 objects.

The v1 SDK remains a development-only dependency for interoperability tests.
The v2 client is test-only. Runtime code imports only the v2 server package.

## Structured output

`PortableTool.outputSchema` is optional, object-shaped TypeBox JSON Schema.
Inlined objects and object intersections are accepted; primitive/union/reference
roots are rejected. Intersections are lowered to `type: "object"` for MCP listing.

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

MCP output-schema construction errors remain `TypeError`s and now carry stable
codes: `BRIDGEKIT_MCP_NON_OBJECT_OUTPUT_SCHEMA` or `BRIDGEKIT_MCP_REF_OUTPUT_SCHEMA`,
with a `createMcpServer:` prefix and root/branch-specific correction guidance.

## Verification and scope

Regression seams: portable execution, Pi registration/results, MCP connected pairs,
spawned legacy/v2-modern stdio clients, cancellation through the public tool seam,
EOF shutdown, and installed tarball declarations/protocol calls.

HTTP/auth, tasks, resources/prompts, additional Pi metadata, and non-object portable
results are out of scope. Passing these tests is not an official conformance claim.

Research and isolated evidence: [research/mcp-protocol-v2.md](research/mcp-protocol-v2.md).
