import { definePortableTool } from "@feniix/bridgekit";
import { createMcpServer } from "@feniix/bridgekit/mcp";
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
