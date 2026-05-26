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

By default (`errorHandling: "return"`, as of 0.7) the pi adapter mirrors the MCP adapter: portable validation failures and portable `isError: true` results surface as `{ content, details, isError: true }` so consumers can branch on `result.isError` and narrow with `isValidationFailure` / `isDomainFailure`. Unexpected handler exceptions are caught and surfaced as `{ content: [{type:"text", text: message}], details: {}, isError: true }`, matching MCP. Success-path results include `isError: false` explicitly so consumers can use the same strict-equality checks across both adapters. `details` is populated from `structuredContent` first, then from `details`, then `{}`. Progress updates from `ctx.progress?.(...)` map to pi tool updates.

The pre-0.7 behavior — throw `PortableToolExecutionError` on `isError` — is still available for one deprecation cycle:

```ts
registerPiTools(pi, createTools(), { errorHandling: "throw" });
```

Selecting `errorHandling: "throw"` emits a `DeprecationWarning` (code `BRIDGEKIT_PI_THROW_DEPRECATED`) once per process. Only the `"throw"` value is deprecated; the `errorHandling` option itself remains. Migrate by switching to the default and branching on the returned result:

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
  if (isValidationFailure(result)) {
    // validationErrors is Array<{ field: string; message: string }>.
    for (const { field, message } of result.structuredContent.validationErrors) {
      // ...
    }
  } else if (isDomainFailure(result)) { /* handler-level error */ }
}
```

`PortableValidationError` exposes `{ field, message }`. `field` is derived from TypeBox's structured error data — required-property errors read `params.requiredProperties` (so a prop named `"a,b"` survives intact and the value is locale-independent); other errors take the last meaningful segment of the offending JSON pointer (`text`, not `/text`). One error is emitted per missing required property, and duplicate `(field, message)` pairs (e.g. from union mismatches) are deduplicated. Validation and domain errors share this `{ field, message }` shape, so a consumer reading `.field` does not need to branch on which kind of failure produced the entry. (`path` was the pre-0.8.0 name; it has been removed.)

For array-element validation, `field` is the leaf segment, which can be a numeric index (e.g. `field: "0"`) and loses path context. For root-level schema failures with empty `instancePath` (e.g. `null` passed to a `Type.Object` schema), `field` is the sentinel `"(root)"`.

For **discriminated unions** (`Type.Union([Type.Object({tag: Literal("a"), …}), Type.Object({tag: Literal("b"), …})])`), when exactly one branch's discriminator matches the input, BridgeKit surfaces only that branch's missing-required hints (as of 0.8.2). Recognized discriminator shapes: `Literal` (`const`), `enum`, and `Union of Literals` (`anyOf` of consts). Resolution works inside `Type.Array(...)` per-element. When no branch matches (invalid discriminator), the `anyOf` summary and `const`/`enum` errors survive so consumers can identify the failed discriminator and pick a valid value.

`const`/`enum` error messages carry the allowed value(s) directly (`must equal "create"` / `must equal one of "create", "update"`) so an agent can pick a valid discriminator on retry.

For nested discriminated unions, `field` is the leaf segment of the JSON pointer (`"name"` for `/event/name`), not the full path. Consumers needing full path context for ambiguous prop names should track the active union branch out-of-band.

The two modes expose the failure discriminator on different fields. In the
new default `"return"` mode, prefer the result guards over inspecting a
`kind` field directly — handler-emitted failures do not carry a synthesized
`kind`. In the deprecated `"throw"` mode, the discriminator lives on
`(err as PortableToolExecutionError).details.kind` (`"validation"` or
`"domain"`). The guards operate on a `PortableToolResult`; they are not
designed to be called on the pi adapter's wire object.

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
