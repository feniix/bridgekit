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
  bin/
    my-tools-mcp.js   # checked-in npm bin wrapper for local/workspace resilience
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

### Composing object schemas with `Type.Intersect`

When two object schemas describe different facets of the same input — common
properties plus a feature-specific extension — compose them with
`Type.Intersect`. Both branches must be `Type.Object(...)`; the MCP adapter
synthesises `type: "object"` on the wire so existing MCP SDK clients accept
the composed schema unchanged. Other top-level shapes (`Type.Union(...)`,
`Type.String()`) throw at `createMcpServer` construction.

```ts
import { type Static, Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

const idParams = Type.Object({ id: Type.String({ description: "Record id." }) });
const updateParams = Type.Object({
  name: Type.Optional(Type.String({ description: "New display name." })),
  archived: Type.Optional(Type.Boolean({ description: "Archive flag." })),
});

const params = Type.Intersect([idParams, updateParams]);
type Params = Static<typeof params>; // { id: string; name?: string; archived?: boolean }

export const updateRecordTool = definePortableTool({
  name: "update_record",
  title: "Update Record",
  description: "Update a record by id.",
  parameters: params,
  execute(args: Params) {
    return {
      text: `Updated ${args.id}`,
      structuredContent: { id: args.id, name: args.name, archived: args.archived },
    };
  },
});
```

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
- Invalid arguments and portable results with `isError: true` return `{ content, details, isError: true }` by default; tests should branch on `result.isError` and inspect `details`.
- The legacy throw mode is still available with `registerPiTools(pi, tools, { errorHandling: "throw" })`, but it is deprecated and should not be used for new code.
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
    "@feniix/bridgekit": "^0.13.0",
    "typebox": "^1.1.31"
  }
}
```

For mixed source-loaded pi + compiled MCP packages, keep the pi source entrypoint and point npm `bin` at a checked-in wrapper rather than directly at generated `dist/` output:

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./extensions/index.ts"]
  },
  "bin": {
    "my-tools-mcp": "./bin/my-tools-mcp.js"
  },
  "files": ["bin/", "extensions/", "dist/", "README.md", "LICENSE"],
  "scripts": {
    "build:mcp": "tsc --project tsconfig.mcp.json",
    "prepack": "npm run build:mcp"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "dependencies": {
    "@feniix/bridgekit": "^0.13.0",
    "typebox": "^1.1.31"
  }
}
```

The wrapper should resolve the generated MCP server relative to the installed package, build it when missing in local/workspace execution, and preserve build failures. BridgeKit ships this as a built-in helper under the `/bin-wrapper` subpath:

```js
#!/usr/bin/env node
import { runBinWrapper } from "@feniix/bridgekit/bin-wrapper";

await runBinWrapper({
  metaUrl: import.meta.url,
  mcpEntry: "dist/extensions/mcp-server.js",
  buildScript: "build:mcp",
  // MCP stdio bins: keep build stdout off the JSON-RPC channel.
  buildStdio: ["ignore", "inherit", "inherit"],
});
```

`mcpEntry` and `buildScript` are the two options consumers typically vary. The MCP entry module must export `runServer(): Promise<void>` (the convention used throughout these examples). `buildStdio`, `buildTimeoutMs` (default `60_000`), and `logPrefix` (default `"bridgekit-bin"`) are available for tuning but rarely needed outside MCP-stdio stdout isolation.

Both `mcpEntry` and `buildScript` must be **literal strings** in your bin source. The helper joins `mcpEntry` onto the resolved package root and dynamically `import()`s it, and it passes `buildScript` to `spawnSync` (with `shell: true` on Windows where `&`, `|`, and `^` are shell metacharacters). BridgeKit rejects absolute/traversing entry paths and shell-shaped script names, but sourcing either option from CLI args, environment variables, or other runtime input remains outside the supported threat model.

Commit the wrapper with executable mode (`chmod +x bin/my-tools-mcp.js`) and verify `npm pack --dry-run --json` includes it with executable mode.

MCP behavior:

- `tools/list` exposes TypeBox schemas directly as JSON Schema.
- `tools/call` validates arguments before invoking handlers.
- Invalid arguments and portable `isError: true` results return MCP tool results with `isError: true`.
- Unexpected thrown errors become MCP tool errors with text content.
- The module stays import-passive and testable: tests can import `createMcpServerOptions()` without starting stdio.

---

## 4. Per-host metadata via `hostExtras`

When a tool needs host-specific metadata — pi's `pendingMessage` for a "Processing..." signal, MCP's annotations as advisory hints to clients — the canonical place is `PortableTool.hostExtras`. Each host has its own namespace; adapters read the keys they recognise and ignore the rest. Tools that omit `hostExtras` see no behavior change.

```ts
import { Type } from "typebox";
import { definePortableTool } from "@feniix/bridgekit";

export const summariseTool = definePortableTool({
  name: "summarise",
  title: "Summarise",
  description: "Generate a short summary of a block of text.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args) {
    return { text: args.text.slice(0, 80) };
  },
  hostExtras: {
    pi: {
      // Fires once before TypeBox validation runs — surfaces a "Processing..."
      // signal to the pi host without a custom registration wrapper.
      pendingMessage: "Summarising...",
      promptSnippet: "Use this tool when the user asks for a short summary.",
      promptGuidelines: ["Prefer < 80 chars.", "Strip markdown."],
    },
    mcp: {
      // Advisory hints clients may surface. Do not affect validation or
      // execution; round-trip verbatim on `tools/list` entries.
      annotations: { readOnlyHint: true },
    },
  },
});
```

Best practices for `hostExtras`:

- Keep tool *behavior* host-neutral. `hostExtras` carries *data* the adapter reads on the tool's behalf; do not embed callbacks or runtime logic.
- Set only the fields the adapter recognises; unrecognised keys are silently ignored, but they add noise to the definition.
- If you ship an adapter for a host outside `"pi" | "mcp"`, cast `ctx.host` at the adapter boundary (the host union is fixed since 0.10.0). For type-safe per-host metadata in your adapter's namespace, extend `PortableToolHostExtras` via `declare module "@feniix/bridgekit"` so consumers of your adapter get type safety on the new namespace.

See `docs/rfc-host-extras.md` for the full design rationale (which fields qualify, why a top-level field beats a sidecar map, the closure rule for future additions).

### Migrating from a custom registration loop

Before `hostExtras`, packages that needed pi-specific per-tool metadata
typically kept a sidecar map plus a custom `toPiTool` wrapper that bypassed
`registerPiTools`. The before-shape drifts out of sync the first time a tool
is added without its sidecar entry; the after-shape co-locates the metadata
with the tool, removes the wrapper, and uses the canonical adapter directly.

**Before** — sidecar `PENDING_MESSAGES` plus a custom registration loop:

```ts
// extensions/index.ts (before)
import { executePortableTool } from "@feniix/bridgekit";
import { createTools } from "./tools.js";

const PENDING_MESSAGES: Record<string, string> = {
  generate_summary: "Generating summary...",
  rewrite_paragraph: "Rewriting...",
};

export default function extension(pi: { registerTool: (tool: unknown) => void }) {
  for (const tool of createTools()) {
    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_id: string, params: unknown, signal: AbortSignal, onUpdate?: (u: unknown) => void) {
        onUpdate?.({
          content: [{ type: "text", text: PENDING_MESSAGES[tool.name] ?? "" }],
          details: { status: "pending" },
        });
        const result = await executePortableTool(tool, params, { host: "pi", signal });
        return { content: [{ type: "text", text: result.text }], details: result.structuredContent ?? {} };
      },
    });
  }
}
```

**After** — `pendingMessage` carried on each tool, `registerPiTools` used directly:

```ts
// extensions/tools.ts (after — each tool declares its own pending message)
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
    pi: { pendingMessage: "Generating summary..." },
  },
});

// extensions/index.ts (after — sidecar map deleted, custom loop deleted)
import { registerPiTools } from "@feniix/bridgekit/pi";
import { createTools } from "./tools.js";

export default function extension(pi: Parameters<typeof registerPiTools>[0]) {
  registerPiTools(pi, createTools());
}
```

The sidecar map deletes entirely, the per-tool wrapper deletes, and the
remaining wiring is the same three-line shape every other consumer uses.
See `docs/rfc-host-extras.md` §5 for the canonical motivation and the
per-consumer migration deltas.

---

## 5. Package checklist

For publishable tool packages:

- Compile runtime entrypoints to JavaScript and declarations before packing.
- Use `exports` to expose only supported entrypoints.
- Keep runtime imports in `dependencies`, not only dev dependencies.
- Declare Node `>=22.19.0` when publishing BridgeKit-powered MCP bins.
- Avoid `workspace:` or `file:` ranges in publishable package dependencies.
- Avoid dangling `sourceMappingURL` comments: either publish maps and useful sources, or disable source maps for package builds.
- Ensure the npm bin entrypoint starts with a shebang, is executable (`chmod +x` or equivalent), and appears in `npm pack --dry-run --json` with executable mode.
- When a bin depends on generated output, prefer a checked-in wrapper under `bin/` over pointing directly at `dist/`; for MCP stdio bins set `buildStdio: ["ignore", "inherit", "inherit"]`; test existing output, missing output, failed builds, and successful builds that omit the expected file.
- If only the MCP bin needs compiled output, narrow its tsconfig to the MCP entrypoint and shared host-neutral modules instead of compiling unrelated host adapters.
- Add a packed-install smoke test that installs tarballs into a temporary project.
- For BridgeKit itself, run `npm run check`, `npm run test`, `npm run pack:dry-run`, and `npm run package-smoke` before release.
- Keep imports side-effect free; registration and server startup should happen only in explicit entrypoints.
