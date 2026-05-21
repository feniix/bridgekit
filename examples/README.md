# BridgeKit examples

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

Some packages have a host that intentionally loads TypeScript source directly, while MCP clients launched from npm need compiled JavaScript. For that mixed mode, keep the same boundaries but use a package-local MCP build:

```text
my-pi-extension-package/
  package.json
  extensions/
    tools.ts          # host-neutral portable tools
    index.ts          # source-loaded pi adapter wiring
    mcp-server.ts     # compiled MCP stdio server wiring
  tsconfig.mcp.json   # emits mcp-server.ts + shared modules to dist/
```

---

## 1. Define shared portable tools

```ts
// src/tools.ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

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

export function createTools() {
  return [reverseTextTool];
}
```

Best practices shown here:

- The schema is the single source of truth for structural argument validation.
- The handler returns portable `{ text, structuredContent }` data.
- The handler observes `ctx.signal` without importing a host SDK.
- The `createTools()` factory gives stateful tools a fresh runtime per host instance; stateless packages may still return the same definitions.
- The file has no import-time registration or server startup.

---

## 2. Register tools in a pi extension

```ts
// src/pi-extension.ts
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createTools } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, createTools());
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
- Portable results with `isError: true` reject with `PortableToolExecutionError`; tests should assert a rejected execution plus error `.details`.
- Progress updates from `ctx.progress?.(...)` map to pi updates.

---

## 3. Serve the same tools over MCP stdio

```ts
#!/usr/bin/env node
// src/mcp-server.ts
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CreateMcpServerOptions, runMcpStdioServer } from "@feniix/bridgekit/mcp";
import { createTools } from "./tools.js";

export function createMcpServerOptions(): CreateMcpServerOptions {
  return {
    name: "my-tools",
    version: "0.1.0",
    tools: createTools(),
    instructions: "Use these tools when text needs lightweight transformation.",
  };
}

export async function runServer(): Promise<void> {
  await runMcpStdioServer(createMcpServerOptions());
}

function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return realpathIfPossible(resolve(entrypoint)) === realpathIfPossible(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  await runServer();
}
```

In `package.json`:

```json
{
  "type": "module",
  "bin": {
    "my-tools-mcp": "./dist/src/mcp-server.js"
  },
  "scripts": {
    "build": "tsc -b && chmod +x dist/src/mcp-server.js",
    "prepack": "npm run build"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "dependencies": {
    "@feniix/bridgekit": "^0.2.2",
    "typebox": "^1.1.31"
  }
}
```

For mixed source-loaded pi + compiled MCP packages, keep the pi source entrypoint and point only the npm `bin` at emitted JavaScript:

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./extensions/index.ts"]
  },
  "bin": {
    "my-tools-mcp": "./dist/extensions/mcp-server.js"
  },
  "files": ["extensions/", "dist/", "README.md", "LICENSE"],
  "scripts": {
    "build:mcp": "tsc --project tsconfig.mcp.json && chmod +x dist/extensions/mcp-server.js",
    "prepack": "npm run build:mcp"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "dependencies": {
    "@feniix/bridgekit": "^0.2.2",
    "typebox": "^1.1.31"
  }
}
```

MCP behavior:

- `tools/list` exposes TypeBox schemas directly as JSON Schema.
- `tools/call` validates arguments before invoking handlers.
- Invalid arguments and portable `isError: true` results return MCP tool results with `isError: true`.
- Unexpected thrown errors become MCP tool errors with text content.
- The module stays import-passive and testable: tests can import `createMcpServerOptions()` without starting stdio.

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
} from "@feniix/bridgekit";

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

- Compile runtime entrypoints to JavaScript and declarations before packing.
- Use `exports` to expose only supported entrypoints.
- Keep runtime imports in `dependencies`, not only dev dependencies.
- Declare Node `>=22.19.0` when publishing BridgeKit-powered MCP bins.
- Avoid `workspace:` or `file:` ranges in publishable package dependencies.
- Avoid dangling `sourceMappingURL` comments: either publish maps and useful sources, or disable source maps for package builds.
- Ensure MCP bin output starts with a shebang, is executable (`chmod +x` or equivalent), and appears in `npm pack --dry-run --json` with executable mode.
- If only the MCP bin needs compiled output, narrow its tsconfig to the MCP entrypoint and shared host-neutral modules instead of compiling unrelated host adapters.
- Add a packed-install smoke test that installs tarballs into a temporary project.
- For BridgeKit itself, run `npm run check`, `npm run test`, `npm run pack:dry-run`, and `npm run package-smoke` before release.
- Keep imports side-effect free; registration and server startup should happen only in explicit entrypoints.
