import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool } from "@feniix/bridgekit";
import * as mcp from "@feniix/bridgekit/mcp";
import { createMcpServer } from "@feniix/bridgekit/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
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

// Issue #29: createMcpServer used to reject Type.Intersect at compile time and
// had no runtime check that the schema actually rendered as a top-level object.
// As of 0.9 the type is widened to PortableTool<TSchema> and a construction-
// time guard enforces "top-level object on the wire" — either `type: "object"`
// directly, or `allOf` whose entries are all object schemas (TypeBox's Intersect
// lowering).

test("createMcpServer accepts Type.Intersect of objects and round-trips a call", async () => {
  const intersectParams = Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]);
  const tool = definePortableTool({
    name: "intersect_tool",
    title: "Intersect Tool",
    description: "Verifies Type.Intersect registers, lists, and calls.",
    parameters: intersectParams,
    execute(args) {
      return { text: `${args.a}:${args.b}`, structuredContent: { a: args.a, b: args.b } };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "intersect-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "intersect-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0]?.name, "intersect_tool");
    const result = await client.callTool({ name: "intersect_tool", arguments: { a: "x", b: 1 } });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { a: "x", b: 1 });
  } finally {
    await client.close();
    await server.close();
  }
});

test("createMcpServer throws at construction when a tool's parameters are Type.String() at the top level", () => {
  const tool = definePortableTool({
    name: "foo",
    title: "Foo",
    description: "Non-object top-level parameters; must be rejected at construction.",
    parameters: Type.String(),
    execute(text) {
      return { text };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /"foo"/);
      assert.match(error.message, /Type\.Object\(/);
      return true;
    },
  );
});

// Type.Union of objects lowers to JSON-Schema `anyOf`, which is not a
// top-level object. MCP client support for anyOf at the top level varies, so
// the conservative default is reject-at-construction. Discriminated-union
// input validation is handled by executePortableTool (see core tests); the
// wire-side representation is a separate concern from arg validation.
test("createMcpServer throws at construction for Type.Union of objects at the top level", () => {
  const tool = definePortableTool({
    name: "foo",
    title: "Foo",
    description: "Top-level Union(Object, Object) renders as anyOf; not accepted.",
    parameters: Type.Union([Type.Object({ tag: Type.Literal("a") }), Type.Object({ tag: Type.Literal("b") })]),
    execute(args) {
      return { text: args.tag };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /"foo"/);
      assert.match(error.message, /Type\.Object\(/);
      return true;
    },
  );
});
