# BridgeKit

BridgeKit provides reusable TypeBox-backed tool definitions and adapters for exposing one tool implementation through pi, MCP, and other hosts.

## Runtime support

This package is ESM-only and supports Node.js 20 or newer. Published modules are import-passive and marked as side-effect free; tools are registered or servers are started only when the exported adapter functions are called.

## For coding agents

Read these files in order:

1. `README.md` — public API, contracts, and best practices.
2. `llms.txt` — compact agent-facing usage rules and anti-patterns.
3. `examples/README.md` — copyable layouts for shared tools, pi extensions, MCP stdio servers, and custom hosts.
4. Published declarations such as `dist/src/index.d.ts`, `dist/src/pi.d.ts`, and `dist/src/mcp.d.ts` — canonical installed-package type contracts. In a source checkout, the matching `src/` files contain the same implementation context.

## Entrypoints

```ts
import {
  definePortableTool,
  executePortableTool,
  type PortableTool,
  type PortableToolBuiltInHost,
  type PortableToolContext,
  type PortableToolHost,
  type PortableToolResult,
  type PortableValidationError,
} from "@feniix/bridgekit";
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createMcpServer, runMcpStdioServer } from "@feniix/bridgekit/mcp";
```

- Root entrypoint: host-neutral tool definitions, validation, and execution helpers.
- `/pi`: pi adapter only.
- `/mcp`: MCP server adapter only.

Do not deep-import from `dist/` or `src/` in consuming packages.

## Core tools

Define tools once in host-neutral files:

```ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

export const echoTool = definePortableTool({
  name: "echo",
  title: "Echo",
  description: "Echo text.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args, ctx) {
    return {
      text: args.text,
      structuredContent: { text: args.text, host: ctx.host },
    };
  },
});
```

Tool definition best practices:

- Keep tool files host-neutral: no pi imports, no MCP SDK imports.
- Use TypeBox `Type.Object(...)` schemas so MCP can expose input schemas directly.
- Return `text` for model-visible output and `structuredContent` for machine-readable data.
- Use `isError: true` for expected/domain failures that should be represented as tool output.
- Throw only for unexpected programmer, adapter, or runtime failures.
- Respect `ctx.signal` in long-running tools.
- Use `ctx.progress?.(...)` for incremental updates.
- Keep modules import-passive; do not register tools or start servers at import time.

## pi adapter

```ts
import { registerPiTools } from "@feniix/bridgekit/pi";
import { echoTool } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, [echoTool]);
}
```

Portable validation failures reject with `PortableToolExecutionError` in pi so the host sees a native tool failure. Progress updates from `ctx.progress?.(...)` map to pi tool updates.

## MCP adapter

```ts
import { runMcpStdioServer } from "@feniix/bridgekit/mcp";
import { echoTool } from "./tools.js";

await runMcpStdioServer({
  name: "my-tools",
  version: "0.1.0",
  tools: [echoTool],
  instructions: "Use these tools when text needs processing.",
});
```

The MCP adapter uses low-level `tools/list` and `tools/call` handlers so TypeBox schemas are exposed as JSON Schema directly. It intentionally does not expose a high-level `registerMcpTools` helper.

MCP invalid input and portable `isError: true` results return `CallToolResult` with `isError: true`.

## Custom host typing

Default portable tools accept the built-in host union:

```ts
type BuiltIn = "pi" | "mcp" | "test";
```

Custom adapters opt in explicitly:

```ts
import { Type } from "typebox";
import { definePortableTool, type PortableToolHost } from "@feniix/bridgekit";

const params = Type.Object({ text: Type.String() });

type CustomHost = "custom-runtime";

export const customTool = definePortableTool<typeof params, CustomHost>({
  name: "custom_echo",
  title: "Custom Echo",
  description: "Echoes text in a custom runtime.",
  parameters: params,
  execute(args, ctx) {
    const host: CustomHost = ctx.host;
    return { text: `${host}: ${args.text}` };
  },
});

const hostValue: PortableToolHost<CustomHost> = "custom-runtime";
void hostValue;
```

Use `PortableToolHost<CustomHost>` for values that may be either a built-in host or your extension. Use the `PortableTool`/`PortableToolContext` generic when a tool or adapter is custom-host-only.

## Package and release checklist

- Publish compiled JavaScript plus generated `.d.ts` declarations, not source as runtime code.
- Keep `exports`, `main`, and `types` aligned with built files.
- Keep runtime imports in `dependencies`.
- Avoid `workspace:` or `file:` dependency ranges in publishable packages.
- Avoid dangling `sourceMappingURL` comments: publish maps and useful sources together, or disable source maps for package builds.
- Run a packed-install smoke test in a temporary project.

See `examples/README.md` for complete copyable examples.
