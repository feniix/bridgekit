# Architecture

## Layout
```
src/
  index.ts          # root entrypoint — re-exports core
  pi.ts             # /pi entrypoint — re-exports pi adapter
  mcp.ts            # /mcp entrypoint — re-exports mcp adapter
  core/
    define-tool.ts       # PortableTool types + definePortableTool()
    execute-tool.ts      # validatePortableToolArgs() + executePortableTool()
    execute-tool.test.ts
  adapters/
    pi.ts                # registerPiTools(), PortableToolExecutionError
    pi.test.ts
    mcp.ts               # createMcpServer(), runMcpStdioServer()
    mcp.test.ts
    mcp.integration.test.ts
    mcp-signal.ts        # signalFromExtra() — AbortSignal helper for MCP extras
    mcp.typecheck.ts     # compile-only type assertions
```

## Core contracts (`src/core/define-tool.ts`)

```ts
interface PortableToolResult {
  text: string;                              // model-visible
  structuredContent?: Record<string, unknown>; // machine-readable, preferred by pi & MCP
  details?: Record<string, unknown>;         // legacy/debug fallback
  isError?: boolean;                         // domain failure
}

type PortableToolBuiltInHost = "pi" | "mcp" | "test";
type PortableToolHost<TExt extends string = never> = PortableToolBuiltInHost | TExt;

interface PortableToolContext<THost extends string = PortableToolBuiltInHost> {
  host: THost;
  signal?: AbortSignal;
  progress?: (update: PortableToolResult) => void;
}

interface PortableTool<TParams extends TSchema = TSchema,
                       THost extends string = PortableToolBuiltInHost> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;                       // TypeBox schema
  execute(args: Static<TParams>, ctx: PortableToolContext<THost>):
    PortableToolResult | Promise<PortableToolResult>;
}
```

`definePortableTool(tool)` is an identity function used purely for inference.

## Execution (`src/core/execute-tool.ts`)
- `validatePortableToolArgs` runs TypeBox `Check` + `Errors`, returning `{ok:true}` or `{ok:false, errors: PortableValidationError[]}` (`{path, message}`).
- `executePortableTool` validates first; on failure returns a `PortableToolResult` with `isError: true` (does **not** throw). On success it forwards to `tool.execute`.
- `NoInferPortable` is used to prevent the THost generic from being inferred from `ctx`, forcing it to come from the tool.

## pi adapter (`src/adapters/pi.ts`)
- `registerPiTools(pi, tools)` iterates and calls `pi.registerTool({...})` for each.
- Maps `progress(update)` -> pi `onUpdate({content:[{type:"text",text}], details})`.
- On `result.isError`, throws `PortableToolExecutionError` so pi sees a native tool failure. Otherwise returns `{content:[text], details}`.
- `toPiDetails` prefers `structuredContent`, falls back to `details`, defaults to `{}`.
- `PiToolRegistration` is a structural type expecting only `registerTool(def)` — pi itself is not a dependency.

## MCP adapter (`src/adapters/mcp.ts`)
- Uses the SDK's **low-level** `Server` with `ListToolsRequestSchema` + `CallToolRequestSchema` handlers, **not** the high-level `registerTool` helper. This intentionally exposes TypeBox schemas as `inputSchema` directly without JSON Schema conversion.
- `createMcpServer({name, version, tools, instructions?})` returns a `Server`.
- `runMcpStdioServer(options)` connects it over `StdioServerTransport`.
- `toMcpResult`: `{content:[text], structuredContent: result.structuredContent ?? result.details, isError: result.isError ?? false}`.
- Unknown tool name -> `{content:[error text], isError:true}`.
- Thrown exceptions are caught and surfaced as `isError:true` results (message string).
- `signalFromExtra(extra)` (in `mcp-signal.ts`) pulls an `AbortSignal` from MCP request `extra`.

## Custom hosts
Tools declare a custom host string via the second generic:
```ts
definePortableTool<typeof params, "custom-runtime">({...})
```
`PortableToolHost<CustomHost>` is the union of built-ins + the extension; use it for values that may be either.
