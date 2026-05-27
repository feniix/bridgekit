# BridgeKit

BridgeKit provides reusable TypeBox-backed tool definitions and adapters for exposing one tool implementation through pi, MCP, and other hosts.

## Quickstart

```ts
// src/tools.ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

export const echoTool = definePortableTool({
  name: "echo",
  title: "Echo",
  description: "Echo text back to the caller.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args, ctx) {
    return {
      text: args.text,
      structuredContent: { text: args.text, host: ctx.host },
    };
  },
  hostExtras: {
    pi: { pendingMessage: "Echoing..." },
    mcp: { annotations: { readOnlyHint: true } },
  },
});

export function createTools() {
  return [echoTool];
}
```

```ts
// src/mcp-server.ts
import { runMcpStdioServer } from "@feniix/bridgekit/mcp";
import { createTools } from "./tools.js";

await runMcpStdioServer({
  name: "my-tools",
  version: "0.1.0",
  tools: createTools(),
});
```

```ts
// src/pi-extension.ts
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createTools } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, createTools());
}
```

## Install

```bash
npm install @feniix/bridgekit typebox
```

This package is ESM-only and supports Node.js 22.19.0 or newer. Published modules are import-passive and marked as side-effect free; tools are registered or servers are started only when the exported adapter functions are called.

## Why

- Define a tool once; ship it to pi and MCP without per-host forks.
- Host-neutral tool files: no pi or MCP SDK imports in the tool definition itself.
- TypeBox schemas pass through to MCP `inputSchema` directly — no JSON Schema conversion step.
- Import-passive, `sideEffects: false`, four-entrypoint split (`.`, `./pi`, `./mcp`, `./bin-wrapper`) so pi-only consumers do not pull the MCP SDK and vice versa.
- Conformance-tested public surface: a packed-install smoke test enforces the runtime export set, deep-import rejection, and type-level strictness against the installed declarations.

## API reference

```ts
import {
  definePortableTool,
  executePortableTool,
  isDomainFailure,
  isValidationFailure,
  type PortableTool,
  type PortableToolBuiltInHost,
  type PortableToolContext,
  type PortableToolResult,
  type PortableValidationError,
} from "@feniix/bridgekit";
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createMcpServer, runMcpStdioServer } from "@feniix/bridgekit/mcp";
import { runBinWrapper } from "@feniix/bridgekit/bin-wrapper";
```

- Root entrypoint: host-neutral tool definitions, validation, and execution helpers.
- `/pi`: pi adapter only.
- `/mcp`: MCP server adapter only.
- `/bin-wrapper`: optional helper for npm `bin` scripts that need to build a local compiled MCP entry on first invocation.

Do not deep-import from `dist/` or `src/` in consuming packages.

### pi adapter

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

#### Per-host metadata via `hostExtras`

`PortableTool.hostExtras` is an optional namespace for host-specific fields that should travel with the tool definition rather than a parallel sidecar map. The pi adapter reads `hostExtras.pi`; the MCP adapter reads `hostExtras.mcp`; each adapter ignores keys it does not recognise. Tools that omit `hostExtras` see no behavior change.

```ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

export const generateSummaryTool = definePortableTool({
  name: "generate_summary",
  title: "Generate Summary",
  description: "Summarise a block of text.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args) {
    return { text: args.text.slice(0, 80) };
  },
  hostExtras: {
    pi: {
      // Fires once before TypeBox validation runs. Lets the pi host show a
      // "Processing..." signal without a custom registration wrapper.
      pendingMessage: "Summarising...",
      promptSnippet: "Use this tool when the user asks for a short summary.",
      promptGuidelines: ["Prefer < 80 chars.", "Strip markdown."],
    },
    mcp: {
      annotations: { readOnlyHint: true },
    },
  },
});
```

See `docs/rfc-host-extras.md` for the design rationale (which fields are in scope, why a top-level field beats a sidecar map, the closure rule for future additions). `PortableToolHostExtras` is module-augmentable for custom host adapters; declare your namespace via `declare module "@feniix/bridgekit"`.

### MCP adapter

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

Tool `parameters` must resolve to a JSON-Schema object at the top level. `Type.Object(...)` is the common case; `Type.Intersect([Type.Object(...), Type.Object(...)])` of object schemas is also accepted (its `allOf` lowering is recognised, and `type: "object"` is synthesised onto the `tools/list` response so MCP clients that validate the inputSchema shape stay happy). Non-object top-level schemas (`Type.String()`, `Type.Union([Type.Object(...), Type.Object(...)])`, etc.) throw at server construction with a named-tool error so the failure surfaces at adapter setup, not at first `tools/call`.

Portable validation failures and portable `isError: true` results return `CallToolResult` with `isError: true`. `structuredContent` is preserved; `details` is used only as a fallback when `structuredContent` is absent. Exporting a server-options factory keeps MCP entrypoints import-passive and easy to test without starting stdio.

The two adapters now read in parallel: invalid args and portable `isError` results return `{ isError: true }` from both hosts by default, and the same result-guard helpers (`isValidationFailure`, `isDomainFailure`) narrow them on either side.

### bin-wrapper (since 0.11.0)

The `bin-wrapper` subpath ships a helper for npm `bin` scripts that load a compiled MCP entrypoint and build it on first invocation when the compiled output is missing. Replaces the ~25-line "resolve dist path → spawn build if missing → import and run" boilerplate that downstream consumers with mixed source-loaded pi + compiled MCP packages previously hand-rolled.

```js
#!/usr/bin/env node
import { runBinWrapper } from "@feniix/bridgekit/bin-wrapper";

await runBinWrapper({
  metaUrl: import.meta.url,
  mcpEntry: "dist/extensions/mcp-server.js",
  buildScript: "build:mcp",
});
```

Options:

- `metaUrl` (required): `import.meta.url` of the bin script. Used to locate the package root (the bin's parent directory).
- `mcpEntry` (required): path to the compiled MCP entry, relative to the package root (e.g. `"dist/extensions/mcp-server.js"`).
- `buildScript` (required): npm script to invoke when the entry is missing (e.g. `"build:mcp"`).
- `buildTimeoutMs` (optional, default `60_000`): timeout for the build subprocess. Distinct "Build timed out…" diagnostic fires when exceeded.
- `logPrefix` (optional, default `"bridgekit-bin"`): prefix on the "Failed to build…" diagnostic.
- `buildStdio` (optional, default `"inherit"`): `stdio` mode passed to `spawnSync` when the build script runs. **MCP stdio server bins should pass `["ignore", "inherit", "inherit"]`** so the build subprocess's stdout cannot contaminate the parent's JSON-RPC framing channel (`process.stdout`). stderr stays inherited so build diagnostics remain visible.

The MCP entry module must export `async function runServer(): Promise<void>`. Consumers with a different export name can alias on export.

**Security: `mcpEntry` and `buildScript` must be literal strings in the caller's source.** The helper joins `mcpEntry` onto the resolved package root and dynamically `import()`s it, and it passes `buildScript` to `spawnSync` (with `shell: true` on Windows where `&`, `|`, and `^` are shell metacharacters). Sourcing either from CLI args or environment variables exposes arbitrary-file import and Windows command injection.

Behavior on missing entry:

- Build emits the entry → import and call `runServer()`.
- Build exits non-zero but the entry exists → recover (import and call `runServer()`).
- Build exits 0 but the entry is still missing → exit with code 1, generic "Failed to build…" diagnostic.
- Build exits non-zero with entry missing → exit with the build's status code, generic diagnostic.
- Build killed by timeout (SIGTERM) → exit 1, distinct timeout diagnostic naming `buildTimeoutMs`.

## Best practices

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

## Packaging

Package and release checklist:

- Publish compiled JavaScript plus generated `.d.ts` declarations for runtime entrypoints.
- Keep `exports`, `main`, and `types` aligned with built files.
- Keep runtime imports in `dependencies`.
- Avoid `workspace:` or `file:` dependency ranges in publishable packages.
- Avoid dangling `sourceMappingURL` comments: publish maps and useful sources together, or disable source maps for package builds.
- For MCP stdio bins, ensure the executable entrypoint starts with a Node shebang, has executable mode (`chmod +x` or equivalent), and is included by `npm pack --dry-run --json`.
- If an npm-launched bin depends on generated output, use `runBinWrapper` from `@feniix/bridgekit/bin-wrapper` (since 0.11.0) — it resolves the package-local generated entry, runs the package-local build when output is missing in workspace/local execution, preserves build failures, and distinguishes timeout from build error in its diagnostic. The bin script becomes a three-line invocation; no hand-rolled wrapper needed.
- If a package keeps a source-loaded host entrypoint (for example a pi extension source file), use a package-local MCP build behind that wrapper and narrow the build to the MCP entrypoint plus shared host-neutral modules.
- Declare a compatible Node engine (`>=22.19.0`) in downstream packages that expose BridgeKit-powered MCP bins.
- Run `npm run check`, `npm run test`, `npm run pack:dry-run`, and `npm run package-smoke` before publishing.
- Treat `docs/releasing.md` as the future release handoff; this repository is not configured for automated publish yet.

See `examples/README.md` for complete copyable examples.

## For coding agents

Read these files in order:

1. `README.md` — public API, contracts, and best practices.
2. `llms.txt` — compact agent-facing usage rules and anti-patterns.
3. `examples/README.md` — copyable layouts for shared tools, pi extensions, MCP stdio servers, per-host metadata via `hostExtras`, and bin wrappers via `runBinWrapper`.
4. Published declarations such as `dist/src/index.d.ts`, `dist/src/pi.d.ts`, `dist/src/mcp.d.ts`, and `dist/src/bin-wrapper.d.ts` — canonical installed-package type contracts. In a source checkout, the matching `src/` files contain the same implementation context.
