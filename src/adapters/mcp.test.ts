import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, type PortableToolHostExtras } from "@feniix/bridgekit";
import * as mcp from "@feniix/bridgekit/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { signalFromExtra } from "./mcp-signal.js";

// Pull from the namespace import so `surface.registerMcpTools === undefined`
// (above) stays load-bearing on the same symbol the rest of the file uses.
const { createMcpServer } = mcp;

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
    // Wire-shape contract: top-level `type: "object"` must be present (the
    // MCP SDK Zod-validates it on the client side), and the original
    // `allOf` composition must round-trip unchanged so client-side
    // validators can still see the per-branch object schemas.
    const inputSchema = list.tools[0]?.inputSchema as { type?: string; allOf?: unknown[] };
    assert.equal(inputSchema?.type, "object");
    assert.ok(Array.isArray(inputSchema?.allOf));
    assert.equal(inputSchema?.allOf?.length, 2);
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
      assert.match(error.message, /^createMcpServer: tool "foo"/);
      assert.match(error.message, /Type\.Object\(/);
      assert.equal((error as Error & { code?: string }).code, "BRIDGEKIT_MCP_NON_OBJECT_PARAMETERS");
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
      assert.match(error.message, /^createMcpServer: tool "foo"/);
      assert.match(error.message, /Type\.Object\(/);
      // Union-specific guidance: Type.Intersect (AND) is the wrong recipe
      // for a Union (OR), so the message must point at flatten/split.
      assert.match(error.message, /flatten branches/);
      return true;
    },
  );
});

// Issue #44: Type.Cyclic produces `{ $defs: {...}, $ref: "Name" }` at the
// root. Before 0.9.3, this fell through to the generic "wrap with
// Type.Object" recipe, which is the wrong fix for a recursive schema (the
// user wants to express recursion, not wrap a primitive). The new branch
// surfaces $ref-specific guidance (inline or split) and a stable error code
// `BRIDGEKIT_MCP_REF_PARAMETERS` so consumers can branch on the cause.
test("createMcpServer rejects Type.Cyclic / top-level $ref schemas with $ref-specific guidance", () => {
  const Node = Type.Object({ value: Type.String(), children: Type.Array(Type.Ref("Node")) });
  const recursive = Type.Cyclic({ Node }, "Node");
  const tool = definePortableTool({
    name: "recursive_tool",
    title: "Recursive Tool",
    description: "Schema that recurses on itself via Type.Cyclic.",
    parameters: recursive,
    execute: () => ({ text: "ok" }),
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^createMcpServer: tool "recursive_tool"/);
      assert.match(error.message, /type="\$ref"/);
      // Recipe must mention either inlining or splitting; NOT the
      // misdirecting "wrap with Type.Object" recipe from the generic branch.
      assert.ok(
        /inline.*Type\.Object|split.*recursive/i.test(error.message),
        "expected $ref-specific recipe (inline or split)",
      );
      // Load-bearing negative: the generic recipe's exact example string
      // (`Type.Object({ value: Type.String() })`) must NOT appear. Without
      // this assertion, the test would pass even if $ref shapes fell into
      // the generic Type.Object wrap recipe branch.
      assert.ok(
        !/Type\.Object\(\{ value: Type\.String\(\) \}\)/.test(error.message),
        "must not emit the generic Type.Object wrap recipe for $ref shapes",
      );
      assert.equal((error as Error & { code?: string }).code, "BRIDGEKIT_MCP_REF_PARAMETERS");
      return true;
    },
  );
});

test("createMcpServer throws at construction for empty Type.Intersect", () => {
  const tool = definePortableTool({
    name: "empty_intersect",
    title: "Empty Intersect",
    description: "Empty Type.Intersect; must be rejected at construction.",
    parameters: Type.Intersect([]),
    execute() {
      return { text: "noop" };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^createMcpServer: tool "empty_intersect"/);
      return true;
    },
  );
});

test("createMcpServer throws at construction for Type.Intersect mixing an object and a primitive branch", () => {
  const tool = definePortableTool({
    name: "mixed_intersect",
    title: "Mixed Intersect",
    description: "Mixed-branch Type.Intersect; must be rejected at construction.",
    parameters: Type.Intersect([Type.Object({ a: Type.String() }), Type.String()]),
    execute() {
      return { text: "noop" };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^createMcpServer: tool "mixed_intersect"/);
      // Name the offending branch index, not a bare "allOf" label.
      assert.match(error.message, /allOf\[1\]/);
      return true;
    },
  );
});

test("createMcpServer's union-specific guidance fires when a Union is nested inside an Intersect branch", () => {
  const tool = definePortableTool({
    name: "intersect_with_nested_union",
    title: "Intersect With Nested Union",
    description: "Type.Union nested inside an Intersect branch; guidance must still flag the union.",
    parameters: Type.Intersect([
      Type.Object({ a: Type.String() }),
      Type.Union([Type.Object({ tag: Type.Literal("x") }), Type.Object({ tag: Type.Literal("y") })]),
    ]),
    execute() {
      return { text: "noop" };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^createMcpServer: tool "intersect_with_nested_union"/);
      assert.match(error.message, /allOf\[1\]/);
      assert.match(error.message, /flatten branches/);
      return true;
    },
  );
});

test("createMcpServer accepts nested Type.Intersect of object schemas and round-trips a call", async () => {
  const nestedParams = Type.Intersect([
    Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
    Type.Object({ c: Type.Boolean() }),
  ]);
  const tool = definePortableTool({
    name: "nested_intersect",
    title: "Nested Intersect",
    description: "Verifies recursive allOf descent accepts the schema.",
    parameters: nestedParams,
    execute(args) {
      return { text: `${args.a}:${args.b}:${args.c}`, structuredContent: { a: args.a, b: args.b, c: args.c } };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "nested-intersect-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "nested-intersect-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0]?.name, "nested_intersect");
    const inputSchema = list.tools[0]?.inputSchema as { type?: string; allOf?: unknown[] };
    assert.equal(inputSchema?.type, "object");
    assert.ok(Array.isArray(inputSchema?.allOf));
    const result = await client.callTool({
      name: "nested_intersect",
      arguments: { a: "x", b: 1, c: true },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { a: "x", b: 1, c: true });
  } finally {
    await client.close();
    await server.close();
  }
});

test("createMcpServer rejects duplicate tool names at construction", () => {
  const toolA = definePortableTool({
    name: "dup",
    title: "Dup A",
    description: "First registration.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
  });
  const toolB = definePortableTool({
    name: "dup",
    title: "Dup B",
    description: "Second registration with the same name.",
    parameters: Type.Object({ value: Type.Number() }),
    execute(args) {
      return { text: String(args.value) };
    },
  });

  assert.throws(
    () => createMcpServer({ name: "bad-server", version: "0.1.0", tools: [toolA, toolB] }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^createMcpServer: tool "dup" is registered more than once/);
      assert.equal((error as Error & { code?: string }).code, "BRIDGEKIT_MCP_DUPLICATE_TOOL_NAME");
      return true;
    },
  );
});

test("createMcpServer accepts Type.Optional(Type.Object(...)) at the top level", async () => {
  // TypeBox 1.x lowers Type.Optional by setting a flag, not by wrapping the
  // schema, so the JSON-Schema shape is still { type: "object", ... }. The
  // guard accepts it. Pinned here so a TypeBox upgrade that changes the
  // lowering (e.g., wrapping in Union) is caught.
  const tool = definePortableTool({
    name: "optional_object",
    title: "Optional Object",
    description: "Type.Optional(Type.Object(...)) at the top level.",
    parameters: Type.Optional(Type.Object({ value: Type.String() })),
    execute(args) {
      return { text: args?.value ?? "" };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "optional-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "optional-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.equal((list.tools[0]?.inputSchema as { type?: string })?.type, "object");
  } finally {
    await client.close();
    await server.close();
  }
});

test("createMcpServer preserves Type.Object inputSchema shape byte-for-byte", async () => {
  // Backward-compatibility anchor: existing Type.Object consumers must see
  // the same wire payload before and after the 0.9 widening. If a future
  // refactor of toInputSchema spreads or rebuilds the Type.Object branch,
  // this assertion breaks.
  const params = Type.Object({
    name: Type.String({ description: "User name." }),
    age: Type.Optional(Type.Number()),
  });
  const tool = definePortableTool({
    name: "echo_object",
    title: "Echo Object",
    description: "Type.Object passthrough.",
    parameters: params,
    execute(args) {
      return { text: args.name };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "object-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "object-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools[0]?.inputSchema, params as unknown as Record<string, unknown>);
  } finally {
    await client.close();
    await server.close();
  }
});

// --- hostExtras.mcp.annotations (issue #28, RFC §3 / §4) ---

test("tools/list omits the `annotations` field entirely when hostExtras is absent (Test B)", async () => {
  // Zero-cost-when-absent: a tool without hostExtras must produce a Tool
  // entry with no `annotations` key at all — not `annotations: {}`, not
  // `annotations: null`. Pinned so a future refactor that always emits the
  // key (even when empty) regresses byte-identical compatibility with
  // 0.8.x consumers.
  const tool = definePortableTool({
    name: "no_extras",
    title: "No Extras",
    description: "Tool without hostExtras; annotations must be absent on the wire.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "no-extras-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "no-extras-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    const entry = list.tools[0] as Record<string, unknown>;
    assert.equal(
      "annotations" in entry,
      false,
      `expected no 'annotations' key on Tool entry; got: ${JSON.stringify(entry)}`,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("tools/list carries hostExtras.mcp.annotations verbatim", async () => {
  const tool = definePortableTool({
    name: "annotated",
    title: "Annotated",
    description: "Tool with mcp annotations.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
    hostExtras: {
      mcp: {
        annotations: {
          title: "Annotated (display)",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "annotations-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "annotations-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.deepEqual(list.tools[0]?.annotations, {
      title: "Annotated (display)",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("tools/list carries a partial annotations object verbatim (only readOnlyHint set)", async () => {
  // Most common case in practice: a single advisory hint. Pinned so partial
  // annotations objects round-trip without keys being synthesized.
  const tool = definePortableTool({
    name: "read_only_tool",
    title: "Read Only",
    description: "Tool that advertises readOnlyHint only.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
    hostExtras: {
      mcp: {
        annotations: { readOnlyHint: true },
      },
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "partial-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "partial-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools[0]?.annotations, { readOnlyHint: true });
  } finally {
    await client.close();
    await server.close();
  }
});

test("post-construction mutation of hostExtras.mcp.annotations does not leak to tools/list", async () => {
  // The annotations object is held by reference at the call site; without
  // a snapshot at construction, a consumer mutating it after creating the
  // server would silently change subsequent tools/list responses. The MCP
  // adapter shallow-clones the annotations object at construction so the
  // snapshot guarantee is structural, not by-convention.
  const annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {
    readOnlyHint: true,
  };
  const tool = definePortableTool({
    name: "snapshotted",
    title: "Snapshotted",
    description: "Annotations must be snapshotted at construction.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
    hostExtras: { mcp: { annotations } },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "snapshot-annotations", version: "0.1.0", tools: [tool] });
  // Mutate the original annotations object after construction. The snapshot
  // guarantee says this must not affect what tools/list returns.
  annotations.readOnlyHint = false;
  annotations.destructiveHint = true;

  const client = new Client({ name: "snapshot-annotations-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.deepEqual(
      list.tools[0]?.annotations,
      { readOnlyHint: true },
      "tools/list must reflect the construction-time snapshot, not the mutated original",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("createMcpServer omits annotations key when hostExtras.mcp.annotations is an empty object", async () => {
  // RFC §4 + Finding 10: an explicitly empty annotations object is
  // semantically identical to no annotations. The wire payload must not
  // carry an empty `annotations: {}` entry — it would add noise without
  // semantics and would not round-trip byte-for-byte with the absent case.
  const tool = definePortableTool({
    name: "empty_annotations",
    title: "Empty Annotations",
    description: "hostExtras.mcp.annotations = {}; must be omitted from tools/list.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
    hostExtras: { mcp: { annotations: {} } },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "empty-annotations-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "empty-annotations-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    const entry = list.tools[0] as Record<string, unknown>;
    assert.equal(
      "annotations" in entry,
      false,
      `expected no 'annotations' key on Tool entry when annotations: {}; got: ${JSON.stringify(entry)}`,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("createMcpServer's tools/list payload is unaffected by post-construction mutation of the tools array", async () => {
  const initialTool = definePortableTool({
    name: "initial",
    title: "Initial",
    description: "Registered at construction.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
  });
  const sneakyTool = definePortableTool({
    name: "sneaky",
    title: "Sneaky",
    description: "Pushed after construction; must not appear on the wire.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
  });

  const tools = [initialTool];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "snapshot-test", version: "0.1.0", tools });
  // Push *after* construction. The snapshot guarantee says this must not
  // affect tools/list or tools/call.
  tools.push(sneakyTool);

  const client = new Client({ name: "snapshot-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    assert.equal(list.tools[0]?.name, "initial");
    const sneakyResult = await client.callTool({ name: "sneaky", arguments: { value: "x" } });
    assert.equal(sneakyResult.isError, true);
    assert.ok(Array.isArray(sneakyResult.content));
    assert.match((sneakyResult.content as Array<{ text: string }>)[0]?.text ?? "", /Unknown tool: sneaky/);
  } finally {
    await client.close();
    await server.close();
  }
});

// RFC §9 #2 [GATING] — Zero-cost shape: hostExtras: {} (empty object).
//
// Four tools that differ only in how empty/absent their hostExtras are must
// produce observationally identical Tool entries on the MCP wire: no
// `annotations` key on any of them.
test("hostExtras: {} produces byte-identical tools/list entry to absent hostExtras (RFC §9 #2 GATING)", async () => {
  const params = Type.Object({ value: Type.String() });
  const execute = (args: { value: string }) => ({ text: args.value });
  const toolA = definePortableTool({
    name: "no_extras",
    title: "No Extras",
    description: "No hostExtras at all.",
    parameters: params,
    execute,
  });
  const toolB = definePortableTool({
    name: "empty_extras",
    title: "Empty Extras",
    description: "hostExtras: {}.",
    parameters: params,
    execute,
    hostExtras: {},
  });
  const toolC = definePortableTool({
    name: "empty_mcp",
    title: "Empty Mcp",
    description: "hostExtras: { mcp: {} }.",
    parameters: params,
    execute,
    hostExtras: { mcp: {} },
  });
  const toolD = definePortableTool({
    name: "empty_annotations",
    title: "Empty Annotations",
    description: "hostExtras: { mcp: { annotations: {} } }.",
    parameters: params,
    execute,
    hostExtras: { mcp: { annotations: {} } },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    name: "empty-extras-test",
    version: "0.1.0",
    tools: [toolA, toolB, toolC, toolD],
  });
  const client = new Client({ name: "empty-extras-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 4);
    for (const entry of list.tools) {
      const record = entry as Record<string, unknown>;
      assert.equal(
        "annotations" in record,
        false,
        `expected no 'annotations' key on Tool ${record.name}; got: ${JSON.stringify(record)}`,
      );
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// RFC §9 #8 — Unknown-host keys runtime ignored.
//
// A tool carrying `hostExtras["custom-runtime"]` must not affect the MCP
// adapter's wire output: the unknown namespace is opaque to the MCP path
// (it only reads `hostExtras.mcp`), and no leak of custom-runtime keys
// appears on the Tool entry.
test("createMcpServer ignores unknown host namespaces at runtime (RFC §9 #8)", async () => {
  const sneakyExtras = { "custom-runtime": { foo: "bar" } } as unknown as PortableToolHostExtras;
  const tool = definePortableTool({
    name: "sneaky_mcp",
    title: "Sneaky MCP",
    description: "Tool with an unknown-host namespace; MCP must ignore it.",
    parameters: Type.Object({ value: Type.String() }),
    execute(args) {
      return { text: args.value };
    },
    hostExtras: sneakyExtras,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ name: "unknown-host-test", version: "0.1.0", tools: [tool] });
  const client = new Client({ name: "unknown-host-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 1);
    const entry = list.tools[0] as Record<string, unknown>;
    assert.equal(
      "annotations" in entry,
      false,
      `expected no 'annotations' key on Tool entry; got: ${JSON.stringify(entry)}`,
    );
    // Invocation succeeds normally — the unknown namespace is not surfaced.
    const result = await client.callTool({ name: "sneaky_mcp", arguments: { value: "x" } });
    assert.equal(result.isError, false);
  } finally {
    await client.close();
    await server.close();
  }
});
