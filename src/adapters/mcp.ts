import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { TObject } from "typebox";
import type { PortableTool, PortableToolResult } from "../core/define-tool.js";
import { executePortableTool } from "../core/execute-tool.js";
import { signalFromExtra } from "./mcp-signal.js";

export interface CreateMcpServerOptions {
  name: string;
  version: string;
  tools: readonly PortableTool<TObject>[];
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

export function createMcpServer(options: CreateMcpServerOptions): Server {
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
