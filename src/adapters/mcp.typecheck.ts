import { definePortableTool } from "@feniix/pi-portable-tools";
import { createMcpServer } from "@feniix/pi-portable-tools/mcp";
import { Type } from "typebox";

const stringParamTool = definePortableTool({
  name: "string_params",
  title: "String Params",
  description: "Invalid MCP params shape.",
  parameters: Type.String(),
  execute(text) {
    return { text };
  },
});

// @ts-expect-error MCP tools must use TypeBox object parameter schemas.
createMcpServer({ name: "bad-server", version: "0.1.0", tools: [stringParamTool] });
