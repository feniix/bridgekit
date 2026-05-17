import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { definePortableTool } from "@feniix/pi-portable-tools";
import * as mcp from "@feniix/pi-portable-tools/mcp";

test("MCP subpath exposes the supported low-level server API only", () => {
  assert.deepEqual(Object.keys(mcp).sort(), ["createMcpServer", "runMcpStdioServer"]);
  const unsupportedHighLevelHelper = ["register", "McpTools"].join("");
  assert.equal(unsupportedHighLevelHelper in mcp, false);
});

test("createMcpServer returns a connectable MCP server", () => {
  const server = mcp.createMcpServer({
    name: "test-server",
    version: "0.1.0",
    tools: [],
    instructions: "Test server instructions.",
  });

  assert.equal(typeof server.connect, "function");
  assert.equal(typeof server.close, "function");
});

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
mcp.createMcpServer({ name: "bad-server", version: "0.1.0", tools: [stringParamTool] });
