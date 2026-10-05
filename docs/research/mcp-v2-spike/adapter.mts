import { definePortableTool, executePortableTool } from "@feniix/bridgekit";
import { Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { Type } from "typebox";

const tool = definePortableTool({
  name: "echo",
  title: "Echo",
  description: "Echo a string.",
  parameters: Type.Object({ text: Type.String() }),
  execute: (args, ctx) => ({
    text: args.text,
    structuredContent: { text: args.text, host: ctx.host, signal: ctx.signal !== undefined },
  }),
});

export function buildServer(): Server {
  const server = new Server({ name: "bridgekit-v2-spike", version: "0.0.0" }, { capabilities: { tools: {} } });
  const outputSchema = { type: "array", items: { type: "string" } };
  const tools: Tool[] = [
    {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      // Same adapter-boundary cast BridgeKit v1 uses after checking the root.
      inputSchema: tool.parameters as unknown as Tool["inputSchema"],
    },
    {
      name: "array",
      description: "Return a modern non-object structured result.",
      inputSchema: { type: "object" },
      outputSchema,
    },
  ];
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
    if (request.params.name === "array") {
      return server.projectCallToolResult(
        {
          content: [{ type: "text", text: "array" }],
          structuredContent: ["a", "b"],
        },
        outputSchema,
      );
    }
    if (request.params.name !== "echo") {
      return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
    }
    const result = await executePortableTool(tool, request.params.arguments ?? {}, {
      host: "mcp",
      signal: ctx.mcpReq.signal,
    });
    return server.projectCallToolResult(
      {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.structuredContent ?? result.details,
        isError: result.isError ?? false,
      },
      undefined,
    );
  });
  return server;
}
