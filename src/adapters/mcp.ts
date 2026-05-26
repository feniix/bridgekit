import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { PortableTool, PortableToolResult } from "../core/define-tool.js";
import { executePortableTool } from "../core/execute-tool.js";
import { signalFromExtra } from "./mcp-signal.js";

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
   * The array is snapshotted at construction; post-construction mutations to
   * the caller's array do not affect `tools/list` or `tools/call`.
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
 * Returns true if `schema` resolves to a JSON-Schema object at the top level —
 * either `{"type": "object", ...}` directly, or an `allOf` composition whose
 * branches are all object schemas (as produced by `Type.Intersect`).
 *
 * The check walks the canonical JSON-Schema shape rather than poking at
 * TypeBox `Kind` symbols, mirroring how `executePortableTool` traverses
 * schemas. The MCP wire contract is "top-level object," so that's the
 * predicate, regardless of which TypeBox combinator built the schema.
 */
function isObjectSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { type?: unknown; allOf?: unknown };
  if (candidate.type === "object") return true;
  if (Array.isArray(candidate.allOf) && candidate.allOf.length > 0) {
    return candidate.allOf.every((entry) => isObjectSchema(entry));
  }
  return false;
}

/**
 * Best-effort human-readable label for a non-object schema, used in error
 * messages. For `allOf` (TypeBox's `Intersect` lowering) we descend into the
 * branches and surface the first non-object branch by index — a bare `"allOf"`
 * label is misleading because the rejection is owned by one specific branch,
 * not the composition itself.
 */
function schemaTypeLabel(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "unknown";
  const candidate = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown; allOf?: unknown };
  if (typeof candidate.type === "string") return candidate.type;
  if (Array.isArray(candidate.anyOf)) return "anyOf";
  if (Array.isArray(candidate.oneOf)) return "oneOf";
  if (Array.isArray(candidate.allOf)) {
    if (candidate.allOf.length === 0) return "allOf (empty)";
    for (let i = 0; i < candidate.allOf.length; i++) {
      if (!isObjectSchema(candidate.allOf[i])) {
        return `allOf[${i}] resolves to type="${schemaTypeLabel(candidate.allOf[i])}"`;
      }
    }
    return "allOf";
  }
  return "unknown";
}

function isUnionLikeShape(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { anyOf?: unknown; oneOf?: unknown };
  return Array.isArray(candidate.anyOf) || Array.isArray(candidate.oneOf);
}

/**
 * Render `parameters` as MCP `inputSchema`. The MCP SDK Zod-validates that the
 * top-level schema has `type: "object"` on the client side of `tools/list`, so
 * `Type.Intersect` (which TypeBox renders as `{ allOf: [...] }` with no top-
 * level `type`) needs `type: "object"` synthesized before transmission. This
 * is a no-op for `Type.Object` schemas, which already carry the field.
 */
function toInputSchema(parameters: TSchema): Tool["inputSchema"] {
  const candidate = parameters as unknown as { type?: unknown };
  if (candidate.type === "object") {
    return parameters as unknown as Tool["inputSchema"];
  }
  return { type: "object", ...(parameters as Record<string, unknown>) } as unknown as Tool["inputSchema"];
}

function assertObjectShapedParameters(tools: readonly PortableTool<TSchema>[]): void {
  for (const tool of tools) {
    if (!isObjectSchema(tool.parameters)) {
      const typeLabel = schemaTypeLabel(tool.parameters);
      let message =
        `createMcpServer: tool "${tool.name}" has a non-object parameters schema (type="${typeLabel}"). ` +
        "MCP requires Type.Object(...) at the top level; use Type.Object({ value: Type.String() }) " +
        "to wrap a single-field schema, or Type.Intersect([Type.Object(...), Type.Object(...)]) for " +
        "merged object schemas.";
      if (isUnionLikeShape(tool.parameters)) {
        // Top-level Union lowers to `anyOf`/`oneOf` (OR). The generic
        // `Type.Intersect` (AND) advice above is the wrong recipe for that
        // case, so append union-specific guidance.
        message +=
          " Top-level Type.Union([Type.Object(...), ...]) is not supported by the MCP wire layer; " +
          "flatten branches into a single Type.Object(...) with optional discriminator fields, " +
          "or expose each branch as a separate tool.";
      }
      throw new Error(message);
    }
  }
}

export function createMcpServer(options: CreateMcpServerOptions): Server {
  assertObjectShapedParameters(options.tools);
  // Snapshot the caller's array so post-construction mutations don't bleed
  // into `tools/list` or the byName lookup. `byName` already pins call-time
  // lookup; the local copy pins listing.
  const tools = [...options.tools];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: options.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(
      (tool): Tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: toInputSchema(tool.parameters),
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
        signal: signalFromExtra(extra),
      });
      return toMcpResult(result);
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
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
