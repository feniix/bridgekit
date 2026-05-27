import { definePortableTool } from "@feniix/bridgekit";
import { createMcpServer } from "@feniix/bridgekit/mcp";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";

// As of 0.9 the `tools` parameter is typed `PortableTool<TSchema>[]`, so the
// type system permits non-object top-level schemas. The runtime guard inside
// `createMcpServer` rejects them at construction with a tool-attributed error;
// this fixture only locks in the compile-time half. See
// `src/adapters/mcp.test.ts` for the runtime-side negative assertions.
const stringParamTool = definePortableTool({
  name: "string_params",
  title: "String Params",
  description: "Non-object MCP params shape; accepted at the type level, rejected at runtime.",
  parameters: Type.String(),
  execute(text) {
    return { text };
  },
});

const intersectParamTool = definePortableTool({
  name: "intersect_params",
  title: "Intersect Params",
  description: "Type.Intersect of objects; accepted by both the type system and the runtime guard.",
  parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
  execute(args) {
    return { text: `${args.a}:${args.b}` };
  },
});

// Type-only assertion that the widened signature accepts both shapes. This file
// is never executed (excluded from `npm test` and the published tarball); only
// `tsc` reads it during the standard typecheck.
createMcpServer({ name: "bad-server", version: "0.1.0", tools: [stringParamTool] });
createMcpServer({ name: "ok-server", version: "0.1.0", tools: [intersectParamTool] });

// Negative type assertion: `tools` must be `PortableTool` definitions, not
// loose object literals. Widening to `PortableTool<TSchema>` did not (and
// must not) widen to `unknown` — a missing `parameters`/`execute` should
// still fail at compile time, otherwise we'd lose the type-level floor that
// catches misuse before the runtime guard.
createMcpServer({
  name: "bad-server",
  version: "0.1.0",
  // @ts-expect-error tools must be PortableTool definitions, not loose objects.
  tools: [{ name: "incomplete" }],
});

// Adversarial pin: `signalFromExtra` was deleted in 0.11.0 (#3) under the
// guarantee that the MCP SDK ships `RequestHandlerExtra<...>` with a
// non-optional `signal: AbortSignal`. `src/adapters/mcp.ts` reads
// `extra.signal` directly with no runtime guard, so a future SDK reshape
// (e.g. `signal?: AbortSignal`, or `signal: AbortSignal | undefined`)
// would silently regress cancellation propagation while every behavior
// test still passes.
//
// The pin uses asymmetric assignability to assert *exact* type equality:
// `Extra["signal"]` must be assignable to `AbortSignal` AND vice versa.
// A widened type (e.g. `AbortSignal | undefined`) breaks the outer
// `extends AbortSignal` branch, the conditional resolves to `false`, and
// the assignment `: _SignalIsExactlyAbortSignal = true` errors at compile
// time (TS2322 — Type 'true' is not assignable to type 'false'). Verified
// in both directions during the 0.10.0 cluster: today passes; a manual
// edit of the SDK's `.d.ts` to make `signal?` optional errors here.
type _SdkExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type _SignalIsExactlyAbortSignal = _SdkExtra["signal"] extends AbortSignal
  ? AbortSignal extends _SdkExtra["signal"]
    ? true
    : false
  : false;
const _signalShapeIsAbortSignal: _SignalIsExactlyAbortSignal = true;
void _signalShapeIsAbortSignal;
