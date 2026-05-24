import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, type PortableTool } from "@feniix/bridgekit";
import { createMcpServer } from "@feniix/bridgekit/mcp";
import { isPortableToolExecutionError, PortableToolExecutionError, registerPiTools } from "@feniix/bridgekit/pi";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fromPartial } from "@total-typescript/shoehorn";
import { type TObject, Type } from "typebox";

/**
 * Adapter compliance suite. The pi and MCP adapters intentionally diverge on
 * failure handling: pi throws because its host contract expects native
 * exceptions; MCP returns `CallToolResult { isError: true }` because that is
 * the MCP wire-level surface. This file parametrizes the *same* portable
 * tools across both adapters so the documented divergence is asserted
 * explicitly, and so a future "harmonization" refactor cannot silently drift
 * the contract.
 */

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
});

const emptyParams = Type.Object({});

const successTool = definePortableTool({
  name: "compliance_success",
  title: "Compliance Success",
  description: "Returns text and structuredContent.",
  parameters: echoParams,
  execute(args) {
    return {
      text: args.text,
      structuredContent: { echoed: args.text },
    };
  },
});

const isErrorTool = definePortableTool({
  name: "compliance_is_error",
  title: "Compliance IsError",
  description: "Returns a domain failure via isError.",
  parameters: emptyParams,
  execute() {
    return {
      text: "domain failure",
      structuredContent: { reason: "intentional" },
      isError: true,
    };
  },
});

const validationTool = definePortableTool({
  name: "compliance_validation",
  title: "Compliance Validation",
  description: "Used to trigger TypeBox validation failure.",
  parameters: echoParams,
  execute(args) {
    return { text: args.text };
  },
});

type RegisteredPiTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
};

function registerPi(tools: ReadonlyArray<PortableTool<TObject>>): Map<string, RegisteredPiTool> {
  const map = new Map<string, RegisteredPiTool>();
  const pi = {
    registerTool(tool: { name: string } & RegisteredPiTool) {
      map.set(tool.name, tool);
    },
  };
  registerPiTools(fromPartial(pi), tools);
  return map;
}

async function withMcpClient(
  tools: ReadonlyArray<PortableTool<TObject>>,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "compliance-test", version: "0.0.0", tools });
  const client = new Client({ name: "compliance-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("pi adapter: success result returns content + details (structuredContent flattened)", async () => {
  const tools = registerPi([successTool]);
  const tool = tools.get("compliance_success");
  assert.ok(tool);
  const result = await tool.execute("call-1", { text: "hello" }, undefined, undefined, {});
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hello" }],
    details: { echoed: "hello" },
  });
});

test("mcp adapter: success result returns content + structuredContent + isError=false", async () => {
  await withMcpClient([successTool], async (client) => {
    const result = await client.callTool({ name: "compliance_success", arguments: { text: "hello" } });
    assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
    assert.deepEqual(result.structuredContent, { echoed: "hello" });
    assert.equal(result.isError, false);
  });
});

test("pi adapter: isError=true throws PortableToolExecutionError with structured details", async () => {
  const tools = registerPi([isErrorTool]);
  const tool = tools.get("compliance_is_error");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-2", {}, undefined, undefined, {}),
    (error: unknown) => {
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.equal(error.message, "domain failure");
      assert.deepEqual(error.details, { kind: "domain", reason: "intentional" });
      return true;
    },
  );
});

test("mcp adapter: isError=true returns CallToolResult with isError=true (does not throw)", async () => {
  await withMcpClient([isErrorTool], async (client) => {
    const result = await client.callTool({ name: "compliance_is_error", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "domain failure" }]);
    assert.deepEqual(result.structuredContent, { reason: "intentional" });
  });
});

test("pi adapter: invalid args throw with validationErrors in details", async () => {
  const tools = registerPi([validationTool]);
  const tool = tools.get("compliance_validation");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-3", { text: 42 }, undefined, undefined, {}),
    (error: unknown) => {
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.equal(error.details.kind, "validation");
      if (error.details.kind !== "validation") return false;
      assert.equal(error.details.tool, "compliance_validation");
      assert.ok(Array.isArray(error.details.validationErrors));
      assert.equal(error.details.validationErrors[0].path, "/text");
      return true;
    },
  );
});

test("mcp adapter: invalid args return isError=true with validationErrors in structuredContent", async () => {
  await withMcpClient([validationTool], async (client) => {
    const result = await client.callTool({ name: "compliance_validation", arguments: { text: 42 } });
    assert.equal(result.isError, true);
    const structured = result.structuredContent as { tool: string; validationErrors: Array<{ path: string }> };
    assert.equal(structured.tool, "compliance_validation");
    assert.ok(Array.isArray(structured.validationErrors));
    assert.equal(structured.validationErrors[0].path, "/text");
  });
});
