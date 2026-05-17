import assert from "node:assert/strict";
import test from "node:test";
import * as mcp from "@feniix/pi-portable-tools/mcp";
import { signalFromExtra } from "./mcp-signal.js";

test("MCP subpath exposes the supported low-level server API only", () => {
  assert.deepEqual(Object.keys(mcp).sort(), ["createMcpServer", "runMcpStdioServer"]);
});

test("signalFromExtra extracts only real AbortSignal instances", () => {
  const controller = new AbortController();

  assert.equal(signalFromExtra(undefined), undefined);
  assert.equal(signalFromExtra("not-an-object"), undefined);
  assert.equal(signalFromExtra({}), undefined);
  assert.equal(signalFromExtra({ signal: "not-a-signal" }), undefined);
  assert.equal(signalFromExtra({ signal: controller.signal }), controller.signal);
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
