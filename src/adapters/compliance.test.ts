import assert from "node:assert/strict";
import test from "node:test";
import {
  definePortableTool,
  isValidationFailure,
  type PortableTool,
  type PortableToolResult,
  type PortableValidationFailure,
} from "@feniix/bridgekit";
import { createMcpServer } from "@feniix/bridgekit/mcp";
import { isPortableToolExecutionError, PortableToolExecutionError, registerPiTools } from "@feniix/bridgekit/pi";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { type TObject, Type } from "typebox";

/**
 * Adapter compliance suite. As of 0.7, pi and MCP behave symmetrically by
 * default: invalid arguments and portable `isError: true` results surface as
 * `{ isError: true }` from both adapters. pi's pre-0.7 "throw on isError"
 * behavior remains available behind `registerPiTools(..., { errorHandling: "throw" })`
 * for a deprecation cycle; the suite covers both modes so the documented
 * contract cannot drift silently.
 */

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
});

const emptyParams = Type.Object({});

type ValidationShape = PortableValidationFailure["structuredContent"];

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

function makeThrowingTool(name: string, message: string) {
  return definePortableTool({
    name,
    title: name,
    description: "Throws unconditionally from the handler.",
    parameters: emptyParams,
    execute() {
      throw new Error(message);
    },
  });
}

type RegisteredPiTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
};

function registerPi(
  tools: ReadonlyArray<PortableTool<TObject>>,
  options?: Parameters<typeof registerPiTools>[2],
): Map<string, RegisteredPiTool> {
  const map = new Map<string, RegisteredPiTool>();
  const pi = {
    registerTool(tool: { name: string } & RegisteredPiTool) {
      map.set(tool.name, tool);
    },
  };
  registerPiTools(fromPartial(pi), tools, options);
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

test("pi adapter (default return mode): success result returns content + details + isError=false", async () => {
  const tools = registerPi([successTool]);
  const tool = tools.get("compliance_success");
  assert.ok(tool);
  const result = await tool.execute("call-1", { text: "hello" }, undefined, undefined, {});
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hello" }],
    details: { echoed: "hello" },
    isError: false,
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

test("pi adapter (default return mode): isError=true returns isError=true (does not throw)", async () => {
  const tools = registerPi([isErrorTool]);
  const tool = tools.get("compliance_is_error");
  assert.ok(tool);
  const result = await tool.execute("call-2", {}, undefined, undefined, {});
  assert.deepEqual(result, {
    content: [{ type: "text", text: "domain failure" }],
    details: { reason: "intentional" },
    isError: true,
  });
});

test("mcp adapter: isError=true returns CallToolResult with isError=true (does not throw)", async () => {
  await withMcpClient([isErrorTool], async (client) => {
    const result = await client.callTool({ name: "compliance_is_error", arguments: {} });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "domain failure" }]);
    assert.deepEqual(result.structuredContent, { reason: "intentional" });
  });
});

test("pi adapter (default return mode): invalid args return isError=true with content + validationErrors in details", async () => {
  const tools = registerPi([validationTool]);
  const tool = tools.get("compliance_validation");
  assert.ok(tool);
  const result = await tool.execute("call-3", { text: 42 }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(typeof result.content[0]?.text, "string");
  const details: ValidationShape = fromAny(result.details);
  assert.equal(details.kind, "validation");
  assert.equal(details.tool, "compliance_validation");
  assert.ok(Array.isArray(details.validationErrors));
  assert.equal(details.validationErrors[0].field, "text");
});

test("mcp adapter: invalid args return isError=true with validationErrors in structuredContent", async () => {
  await withMcpClient([validationTool], async (client) => {
    const result = await client.callTool({ name: "compliance_validation", arguments: { text: 42 } });
    assert.equal(result.isError, true);
    const structured: ValidationShape = fromAny(result.structuredContent);
    assert.equal(structured.tool, "compliance_validation");
    assert.ok(Array.isArray(structured.validationErrors));
    assert.equal(structured.validationErrors[0].field, "text");
  });
});

test("pi adapter (opt-in throw mode): isError=true throws PortableToolExecutionError", async () => {
  const tools = registerPi([isErrorTool], { errorHandling: "throw" });
  const tool = tools.get("compliance_is_error");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-2b", {}, undefined, undefined, {}),
    (error: unknown) => {
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.equal(error.message, "domain failure");
      assert.deepEqual(error.details, { kind: "domain", reason: "intentional" });
      return true;
    },
  );
});

test("pi adapter (opt-in throw mode): invalid args throw with validationErrors in details", async () => {
  const tools = registerPi([validationTool], { errorHandling: "throw" });
  const tool = tools.get("compliance_validation");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("call-3b", { text: 42 }, undefined, undefined, {}),
    (error: unknown) => {
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.equal(error.details.kind, "validation");
      if (error.details.kind !== "validation") return false;
      assert.equal(error.details.tool, "compliance_validation");
      assert.ok(Array.isArray(error.details.validationErrors));
      assert.equal(error.details.validationErrors[0].field, "text");
      return true;
    },
  );
});

test("pi adapter (opt-in throw mode): success result still returns content + details + isError=false", async () => {
  const tools = registerPi([successTool], { errorHandling: "throw" });
  const tool = tools.get("compliance_success");
  assert.ok(tool);
  const result = await tool.execute("call-1b", { text: "hello" }, undefined, undefined, {});
  assert.deepEqual(result, {
    content: [{ type: "text", text: "hello" }],
    details: { echoed: "hello" },
    isError: false,
  });
});

test("pi adapter (explicit return mode): invalid args return isError=true and do not throw", async () => {
  const tools = registerPi([validationTool], { errorHandling: "return" });
  const tool = tools.get("compliance_validation");
  assert.ok(tool);
  const result = await tool.execute("call-explicit-return", { text: 42 }, undefined, undefined, {});
  assert.equal(result.isError, true);
  const details: ValidationShape = fromAny(result.details);
  assert.equal(details.kind, "validation");
  assert.equal(details.tool, "compliance_validation");
});

test("pi adapter (default return mode): unexpected handler throw surfaces as isError=true", async () => {
  const tools = registerPi([makeThrowingTool("compliance_unexpected_throw", "kaboom")]);
  const tool = tools.get("compliance_unexpected_throw");
  assert.ok(tool);
  const result = await tool.execute("call-unexpected", {}, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, "kaboom");
});

test("pi adapter (opt-in throw mode): unexpected handler throw still propagates", async () => {
  const tools = registerPi([makeThrowingTool("compliance_unexpected_throw_legacy", "kaboom-legacy")], {
    errorHandling: "throw",
  });
  const tool = tools.get("compliance_unexpected_throw_legacy");
  assert.ok(tool);
  await assert.rejects(() => tool.execute("call-unexpected-legacy", {}, undefined, undefined, {}), {
    message: "kaboom-legacy",
  });
});

test("result guards apply to the portable result returned from executePortableTool, not the pi wire result", async () => {
  // The guards operate on PortableToolResult (the value executePortableTool
  // produces). The pi adapter's wire object exposes `details` instead of
  // `structuredContent`, so calling the guards on it always returns false.
  const tools = registerPi([validationTool]);
  const tool = tools.get("compliance_validation");
  assert.ok(tool);
  const piWire = await tool.execute("call-guard-scope", { text: 42 }, undefined, undefined, {});
  const widened: PortableToolResult = fromAny(piWire);
  assert.equal(isValidationFailure(widened), false);
});
