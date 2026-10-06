import { type CallToolResult, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { TSchema } from "typebox";
import type { PortableTool, PortableToolResult } from "../core/define-tool.js";
import { executePortableTool } from "../core/execute-tool.js";
import { assertPortableOutputSchema, isObjectSchema, schemaTypeLabel, throwWithCode } from "../core/output-schema.js";

export interface CreateMcpServerOptions {
  name: string;
  version: string;
  /**
   * Portable tools to expose. Each tool's `parameters` must resolve to a
   * JSON-Schema object at the top level — `Type.Object(...)` or
   * `Type.Intersect([Type.Object(...), Type.Object(...)])`. Other top-level
   * shapes (`Type.String()`, `Type.Union([Type.Object(...), Type.Object(...)])`,
   * etc.) throw at `createMcpServer` construction with a tool-attributed error.
   *
   * The outer array is snapshotted at construction; pushing or removing
   * entries from the caller's `tools` array post-construction does not affect
   * `tools/list` or `tools/call`. Schemas inside each tool are held by
   * reference, not deep-cloned — treat `tool.parameters` and `tool.outputSchema` as immutable once
   * `createMcpServer` returns.
   */
  tools: readonly PortableTool<TSchema>[];
  instructions?: string;
}

type McpContent = { type: "text"; text: string };

function toMcpResult(result: PortableToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: result.text } satisfies McpContent],
    structuredContent: result.structuredContent ?? result.details,
    isError: result.isError ?? false,
  };
}

/**
 * Render a validated object schema as MCP `inputSchema` or `outputSchema`.
 * MCP clients require the top-level schema to have `type: "object"`, so
 * `Type.Intersect` (which TypeBox renders as `{ allOf: [...] }` with no top-
 * level `type`) needs `type: "object"` synthesized before transmission. This
 * is a no-op for `Type.Object` schemas, which already carry the field.
 *
 * The casts here are sound because `assertObjectShapedParameters` or
 * `assertPortableOutputSchema` runs first and rejects schemas whose top-level
 * lowering isn't `type:"object"` or `allOf` of objects.
 */
function toMcpObjectSchema(schema: TSchema): Tool["inputSchema"] {
  const candidate = schema as unknown as { type?: unknown };
  if (candidate.type === "object") {
    return schema as unknown as Tool["inputSchema"];
  }
  return { type: "object", ...(schema as Record<string, unknown>) } as unknown as Tool["inputSchema"];
}

/**
 * Stable `error.code` values attached to `createMcpServer` construction
 * failures so consumers have a non-string anchor (the message text is
 * recipe-shaped and may evolve; the code is part of the public contract).
 */
const ERROR_CODE_NON_OBJECT_PARAMETERS = "BRIDGEKIT_MCP_NON_OBJECT_PARAMETERS";
const ERROR_CODE_REF_PARAMETERS = "BRIDGEKIT_MCP_REF_PARAMETERS";
const ERROR_CODE_DUPLICATE_TOOL_NAME = "BRIDGEKIT_MCP_DUPLICATE_TOOL_NAME";

function assertObjectShapedParameters(tools: readonly PortableTool<TSchema>[]): void {
  for (const tool of tools) {
    if (!isObjectSchema(tool.parameters)) {
      const typeLabel = schemaTypeLabel(tool.parameters);
      // Top-level $ref (TypeBox's `Type.Cyclic` lowering, or a bare `Type.Ref`)
      // gets its own branch and code. The generic "wrap with Type.Object(...)"
      // recipe is the wrong fix for a recursive schema — the user wants to
      // express recursion, not wrap a primitive — so a $ref shape needs
      // $ref-specific guidance (inline or split) before the generic branch
      // can run.
      if (typeLabel === "$ref") {
        throwWithCode(
          `createMcpServer: tool "${tool.name}" has a top-level $ref schema (type="$ref"). ` +
            "Top-level $ref / Type.Cyclic schemas are not currently supported by the MCP wire layer " +
            "because tools/list ships inputSchema by value and the SDK client does not resolve $refs. " +
            "Inline the referenced schema (wrap the target shape directly with Type.Object(...)) " +
            "or split recursive shapes into multiple non-recursive tools.",
          ERROR_CODE_REF_PARAMETERS,
        );
      }
      let message =
        `createMcpServer: tool "${tool.name}" has a non-object parameters schema (type="${typeLabel}"). ` +
        "MCP requires Type.Object(...) at the top level; use Type.Object({ value: Type.String() }) " +
        "to wrap a single-field schema, or Type.Intersect([Type.Object(...), Type.Object(...)]) for " +
        "merged object schemas.";
      if (typeLabel.includes("anyOf") || typeLabel.includes("oneOf")) {
        // Union lowers to `anyOf`/`oneOf` (OR) — at the top level or nested
        // inside an `allOf` branch. The generic `Type.Intersect` (AND) advice
        // above is the wrong recipe for that case, so append union-specific
        // guidance.
        message +=
          " Top-level Type.Union([Type.Object(...), ...]) is not supported by the MCP wire layer; " +
          "flatten branches into a single Type.Object(...) with optional discriminator fields, " +
          "or expose each branch as a separate tool.";
      }
      throwWithCode(message, ERROR_CODE_NON_OBJECT_PARAMETERS);
    }
  }
}

function assertUniqueToolNames(tools: readonly PortableTool<TSchema>[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throwWithCode(
        `createMcpServer: tool "${tool.name}" is registered more than once. ` +
          "MCP tool names must be unique within a server — silently overwriting would make the " +
          "earlier registration unreachable on `tools/call`.",
        ERROR_CODE_DUPLICATE_TOOL_NAME,
      );
    }
    seen.add(tool.name);
  }
}

export function createMcpServer(options: CreateMcpServerOptions): Server {
  for (const tool of options.tools) assertPortableOutputSchema(tool, "createMcpServer", "BRIDGEKIT_MCP");
  assertObjectShapedParameters(options.tools);
  assertUniqueToolNames(options.tools);
  // Build the dispatch map and the listing payload at construction so
  // `tools/list` returns a pre-computed array and post-construction mutations
  // to the caller's array cannot leak unvalidated schemas onto the wire.
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const mcpTools: Tool[] = options.tools.map((tool) => {
    const annotations = tool.hostExtras?.mcp?.annotations;
    // MCP advisory hints from `hostExtras.mcp.annotations`. Two gates:
    //   1. `annotations !== undefined` — a tool without hostExtras builds a
    //      Tool entry whose own-property keys are byte-identical to 0.8.x.
    //   2. `Object.keys(annotations).length > 0` — an explicitly empty
    //      annotations object is semantically identical to no annotations
    //      and is omitted from the wire payload (not emitted as `{}`).
    //
    // The non-empty branch shallow-clones the annotations object so that
    // post-construction mutation of the caller's `tool.hostExtras.mcp.annotations`
    // cannot leak into subsequent `tools/list` responses. The clone is
    // safe-by-construction because annotation fields are primitive scalars
    // (the MCP spec defines only `title: string` and four `…Hint: boolean`
    // fields); no nested mutation surface exists.
    const hasAnnotations = annotations !== undefined && Object.keys(annotations).length > 0;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: toMcpObjectSchema(tool.parameters),
      ...(tool.outputSchema !== undefined && { outputSchema: toMcpObjectSchema(tool.outputSchema) }),
      ...(hasAnnotations ? { annotations: { ...annotations } } : {}),
    };
  });
  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      ...(options.instructions !== undefined && { instructions: options.instructions }),
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools: mcpTools }));

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      } satisfies CallToolResult;
    }

    try {
      const result = await executePortableTool(tool, request.params.arguments ?? {}, {
        host: "mcp",
        signal: ctx.mcpReq.signal,
      });
      return server.projectCallToolResult(
        toMcpResult(result),
        tool.outputSchema !== undefined ? toMcpObjectSchema(tool.outputSchema) : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      } satisfies CallToolResult;
    }
  });

  return server;
}

export async function runMcpStdioServer(options: CreateMcpServerOptions): Promise<void> {
  // Validate eagerly, but each discarded probe/connection must own its server:
  // a modern probe installs era-specific handlers before it can be discarded.
  createMcpServer(options);
  serveStdio(() => createMcpServer(options), {
    onerror: (error) => process.stderr.write(`[bridgekit-mcp] ${error.message}\n`),
  });
}
