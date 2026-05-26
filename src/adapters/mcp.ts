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

function schemaTypeLabel(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "unknown";
  const candidate = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown; allOf?: unknown };
  if (typeof candidate.type === "string") return candidate.type;
  if (Array.isArray(candidate.anyOf)) return "anyOf";
  if (Array.isArray(candidate.oneOf)) return "oneOf";
  if (Array.isArray(candidate.allOf)) return "allOf";
  return "unknown";
}

function assertObjectShapedParameters(tools: readonly PortableTool<TSchema>[]): void {
  for (const tool of tools) {
    if (!isObjectSchema(tool.parameters)) {
      const typeLabel = schemaTypeLabel(tool.parameters);
      throw new Error(
        `createMcpServer: tool "${tool.name}" has a non-object parameters schema (type="${typeLabel}"). ` +
          "MCP requires Type.Object(...) at the top level; use Type.Object({ value: Type.String() }) " +
          "to wrap a single-field schema, or Type.Intersect([Type.Object(...), Type.Object(...)]) for " +
          "merged object schemas.",
      );
    }
  }
}

export function createMcpServer(options: CreateMcpServerOptions): Server {
  assertObjectShapedParameters(options.tools);
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: options.name, version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: options.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map(
      (tool): Tool => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.parameters as unknown as Tool["inputSchema"],
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
