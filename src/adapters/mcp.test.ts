import assert from "node:assert/strict";
import test from "node:test";
import * as mcp from "@feniix/pi-portable-tools/mcp";

test("MCP subpath exposes the supported low-level server API only", () => {
  assert.deepEqual(Object.keys(mcp).sort(), ["createMcpServer", "runMcpStdioServer"]);
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
