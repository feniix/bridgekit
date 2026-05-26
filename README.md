# BridgeKit

BridgeKit provides reusable TypeBox-backed tool definitions and adapters for exposing one tool implementation through pi, MCP, and other hosts.

## Runtime support

This package is ESM-only and supports Node.js 22.19.0 or newer. Published modules are import-passive and marked as side-effect free; tools are registered or servers are started only when the exported adapter functions are called.

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
  isDomainFailure,
  isValidationFailure,
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

export function createTools() {
  return [echoTool];
}
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
- For stateful tools, export a `createTools()` factory instead of a module-level singleton so each host runtime gets isolated state.
- TypeBox validation happens before `execute`; use a permissive schema plus domain validation if you need custom guidance for structurally invalid input.

## pi adapter

```ts
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createTools } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, createTools());
}
```

By default (`errorHandling: "return"`, as of 0.7) the pi adapter mirrors the MCP adapter: portable validation failures and portable `isError: true` results surface as `{ content, details, isError: true }` so consumers can branch on `result.isError` and narrow with `isValidationFailure` / `isDomainFailure`. `details` is populated from `structuredContent` first, then from `details`, then `{}`. Progress updates from `ctx.progress?.(...)` map to pi tool updates.

The pre-0.7 behavior — throw `PortableToolExecutionError` on `isError` — is still available for one deprecation cycle:

```ts
registerPiTools(pi, createTools(), { errorHandling: "throw" });
```

`errorHandling: "throw"` is marked `@deprecated` and will be removed in 1.0. Migrate by switching to the default and branching on the returned result:

```ts
// Before (0.6 and earlier)
try {
  const result = await piTool.execute(...);
} catch (err) {
  if (isPortableToolExecutionError(err)) {
    if (err.details.kind === "validation") { /* TypeBox errors */ }
    else { /* domain failure */ }
  }
}

// After (0.7+)
const result = await piTool.execute(...);
if (result.isError) {
  if (isValidationFailure(result)) { /* result.structuredContent.validationErrors */ }
  else if (isDomainFailure(result)) { /* handler-level error */ }
}
```

## MCP adapter

```ts
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
    instructions: "Use these tools when text needs processing.",
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

if (process.argv[1] && realpathIfPossible(resolve(process.argv[1])) === realpathIfPossible(fileURLToPath(import.meta.url))) {
  await runServer();
}
```

The MCP adapter uses low-level `tools/list` and `tools/call` handlers so TypeBox schemas are exposed as JSON Schema directly. It intentionally does not expose a high-level `registerMcpTools` helper.

Portable validation failures and portable `isError: true` results return `CallToolResult` with `isError: true`. `structuredContent` is preserved; `details` is used only as a fallback when `structuredContent` is absent. Exporting a server-options factory keeps MCP entrypoints import-passive and easy to test without starting stdio.

The two adapters now read in parallel: invalid args and portable `isError` results return `{ isError: true }` from both hosts by default, and the same result-guard helpers (`isValidationFailure`, `isDomainFailure`) narrow them on either side.

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

- Publish compiled JavaScript plus generated `.d.ts` declarations for runtime entrypoints.
- Keep `exports`, `main`, and `types` aligned with built files.
- Keep runtime imports in `dependencies`.
- Avoid `workspace:` or `file:` dependency ranges in publishable packages.
- Avoid dangling `sourceMappingURL` comments: publish maps and useful sources together, or disable source maps for package builds.
- For MCP stdio bins, ensure the executable entrypoint starts with a Node shebang, has executable mode (`chmod +x` or equivalent), and is included by `npm pack --dry-run --json`.
- If an npm-launched bin depends on generated output, prefer a checked-in wrapper under `bin/` over pointing `bin` directly at `dist/`; the wrapper should resolve the package-local generated file and may run the package-local build for workspace/local execution.
- If a package keeps a source-loaded host entrypoint (for example a pi extension source file), use a package-local MCP build behind that wrapper and narrow the build to the MCP entrypoint plus shared host-neutral modules.
- Declare a compatible Node engine (`>=22.19.0`) in downstream packages that expose BridgeKit-powered MCP bins.
- Run `npm run check`, `npm run test`, `npm run pack:dry-run`, and `npm run package-smoke` before publishing.
- Treat `docs/releasing.md` as the future release handoff; this repository is not configured for automated publish yet.

See `examples/README.md` for complete copyable examples.
