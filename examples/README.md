# pi-portable-tools examples

These examples show the recommended layout for defining portable tools once and wiring them into pi and MCP hosts.

## Recommended package layout

```text
my-tools-package/
  package.json
  src/
    tools.ts          # host-neutral portable tools
    pi-extension.ts   # pi adapter wiring
    mcp-server.ts     # MCP stdio server wiring
```

Keep `src/tools.ts` free of pi and MCP imports. Host-specific imports belong only in adapter entrypoints.

---

## 1. Define shared portable tools

```ts
// src/tools.ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/pi-portable-tools";

const reverseParams = Type.Object({
  text: Type.String({ description: "Text to reverse." }),
});

export const reverseTextTool = definePortableTool({
  name: "reverse_text",
  title: "Reverse Text",
  description: "Reverse the supplied text.",
  parameters: reverseParams,
  execute(args, ctx) {
    if (ctx.signal?.aborted) {
      return {
        text: "Reverse text was cancelled.",
        structuredContent: { cancelled: true },
        isError: true,
      };
    }

    const output = [...args.text].reverse().join("");
    return {
      text: output,
      structuredContent: {
        input: args.text,
        output,
        host: ctx.host,
      },
    };
  },
});

export const tools = [reverseTextTool];
```

Best practices shown here:

- The schema is the single source of truth for argument validation.
- The handler returns portable `{ text, structuredContent }` data.
- The handler observes `ctx.signal` without importing a host SDK.
- The file has no import-time registration or server startup.

---

## 2. Register tools in a pi extension

```ts
// src/pi-extension.ts
import { registerPiTools } from "@feniix/pi-portable-tools/pi";
import { tools } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, tools);
}
```

In `package.json`:

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./dist/src/pi-extension.js"]
  }
}
```

pi behavior:

- Valid portable results become pi tool results.
- Portable results with `isError: true` reject with `PortableToolExecutionError`.
- Progress updates from `ctx.progress?.(...)` map to pi updates.

---

## 3. Serve the same tools over MCP stdio

```ts
#!/usr/bin/env node
// src/mcp-server.ts
import { runMcpStdioServer } from "@feniix/pi-portable-tools/mcp";
import { tools } from "./tools.js";

await runMcpStdioServer({
  name: "my-tools",
  version: "0.1.0",
  tools,
  instructions: "Use these tools when text needs lightweight transformation.",
});
```

In `package.json`:

```json
{
  "type": "module",
  "bin": {
    "my-tools-mcp": "./dist/src/mcp-server.js"
  }
}
```

MCP behavior:

- `tools/list` exposes TypeBox schemas directly as JSON Schema.
- `tools/call` validates arguments before invoking handlers.
- Invalid arguments and portable `isError: true` results return MCP tool results with `isError: true`.
- Unexpected thrown errors become MCP tool errors with text content.

---

## 4. Use custom host typing for custom adapters

Default portable tools accept only built-in hosts: `"pi" | "mcp" | "test"`.

If you are writing a custom adapter, opt in explicitly so the handler can safely narrow `ctx.host`:

```ts
import { Type } from "typebox";
import {
  definePortableTool,
  executePortableTool,
  type PortableTool,
  type PortableToolContext,
  type PortableToolHost,
} from "@feniix/pi-portable-tools";

const params = Type.Object({ text: Type.String() });

type CustomHost = "custom-runtime";
type CustomTool = PortableTool<typeof params, CustomHost>;

const customTool = definePortableTool<typeof params, CustomHost>({
  name: "custom_echo",
  title: "Custom Echo",
  description: "Echoes text in a custom runtime.",
  parameters: params,
  execute(args, ctx) {
    const host: CustomHost = ctx.host;
    return { text: `${host}: ${args.text}` };
  },
});

async function runCustomTool(tool: CustomTool, text: string) {
  const ctx: PortableToolContext<CustomHost> = { host: "custom-runtime" };
  return executePortableTool(tool, { text }, ctx);
}

const hostValue: PortableToolHost<CustomHost> = "custom-runtime";
void hostValue;
void customTool;
```

Use `PortableToolHost<CustomHost>` for values that can be either a built-in host or your custom extension. Use `PortableToolContext<CustomHost>` or `PortableTool<Schema, CustomHost>` when a tool is custom-host-only.

---

## 5. Package checklist

For publishable tool packages:

- Compile to JavaScript and declarations before packing.
- Use `exports` to expose only supported entrypoints.
- Keep runtime imports in `dependencies`, not only dev dependencies.
- Avoid `workspace:` or `file:` ranges in publishable package dependencies.
- Avoid dangling `sourceMappingURL` comments: either publish maps and useful sources, or disable source maps for package builds.
- Add a packed-install smoke test that installs tarballs into a temporary project.
- Keep imports side-effect free; registration and server startup should happen only in explicit entrypoints.
