import assert from "node:assert/strict";
import test from "node:test";
import * as mcp from "@feniix/bridgekit/mcp";
import { signalFromExtra } from "./mcp-signal.js";

test("MCP subpath exposes createMcpServer and runMcpStdioServer without a high-level register helper", () => {
  const surface = mcp as Record<string, unknown>;
  assert.equal(typeof surface.createMcpServer, "function");
  assert.equal(typeof surface.runMcpStdioServer, "function");
  assert.equal(surface.registerMcpTools, undefined);
});

test("signalFromExtra extracts only real AbortSignal instances", () => {
  const controller = new AbortController();

  assert.equal(signalFromExtra(undefined), undefined);
  assert.equal(signalFromExtra("not-an-object"), undefined);
  assert.equal(signalFromExtra({}), undefined);
  assert.equal(signalFromExtra({ signal: "not-a-signal" }), undefined);
  assert.equal(signalFromExtra({ signal: controller.signal }), controller.signal);
});
