# pi-portable-tools

Reusable TypeBox-backed tool definitions and adapters for exposing one tool implementation through both pi and MCP hosts.

## Runtime support

This package is ESM-only and supports Node.js 18 or newer. Published modules are import-passive and marked as side-effect free; tools are registered or servers are started only when the exported adapter functions are called.

## Core tools

```ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/pi-portable-tools";

export const echoTool = definePortableTool({
  name: "echo",
  title: "Echo",
  description: "Echo text.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args) {
    return { text: args.text, structuredContent: { text: args.text } };
  },
});
```

## pi adapter

```ts
import { registerPiTools } from "@feniix/pi-portable-tools/pi";
import { echoTool } from "./tools.js";

export default function extension(pi) {
  registerPiTools(pi, [echoTool]);
}
```

Portable validation failures reject with `PortableToolExecutionError` in pi so the host sees a native tool failure.

## MCP adapter

```ts
import { runMcpStdioServer } from "@feniix/pi-portable-tools/mcp";
import { echoTool } from "./tools.js";

await runMcpStdioServer({
  name: "my-tools",
  version: "0.1.0",
  tools: [echoTool],
  instructions: "Use these tools when text needs processing.",
});
```

The MCP adapter uses low-level `tools/list` and `tools/call` handlers so TypeBox schemas are exposed as JSON Schema directly. It intentionally does not expose a high-level `registerMcpTools` helper.
