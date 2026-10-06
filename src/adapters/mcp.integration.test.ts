import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, type PortableTool } from "@feniix/bridgekit";
import { type CreateMcpServerOptions, createMcpServer } from "@feniix/bridgekit/mcp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { fromAny } from "@total-typescript/shoehorn";
import { type TSchema, Type } from "typebox";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
  uppercase: Type.Optional(Type.Boolean({ description: "Whether to uppercase the text." })),
});

const emptyParams = Type.Object({});

test("MCP output-schema construction rejects only $ref roots, with a stable code and recipe", () => {
  const tool = definePortableTool({
    name: "bad_output",
    title: "Bad output",
    description: "Invalid output schema",
    parameters: emptyParams,
    outputSchema: Type.Ref("output"),
    execute: () => ({ text: "ok", isError: true }),
  });
  assert.throws(
    () => createMcpServer({ name: "bad", version: "0", tools: [tool] }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      const coded: { code: string } = fromAny(error);
      assert.equal(coded.code, "BRIDGEKIT_MCP_REF_OUTPUT_SCHEMA");
      assert.match(error.message, /^createMcpServer: Invalid outputSchema for bad_output \(type="\$ref"\)/);
      assert.match(error.message, /inline the referenced/);
      return true;
    },
  );
});

function textFromContent(content: unknown): string {
  assert.ok(Array.isArray(content), "tool result content must be an array");
  assert.equal(content[0]?.type, "text");
  return content[0].text;
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
}

function structuredContent(result: unknown): Record<string, unknown> {
  assertRecord(result);
  const content = result.structuredContent;
  assertRecord(content);
  return content;
}

async function withConnectedPair(
  tools: ReadonlyArray<PortableTool<TSchema>>,
  body: (client: Client) => Promise<void>,
  serverOverrides: Partial<CreateMcpServerOptions> = {},
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    name: "portable-tools-test",
    version: "0.1.0",
    instructions: "Use test tools.",
    ...serverOverrides,
    tools,
  });
  const client = new Client({ name: "portable-tools-test-client", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const echoTool = definePortableTool({
  name: "echo_test",
  title: "Echo Test",
  description: "Echo text for MCP tests.",
  parameters: echoParams,
  execute(args) {
    const output = args.uppercase ? args.text.toUpperCase() : args.text;
    return { text: output, structuredContent: { input: args.text, output } };
  },
});

const detailsOnlyTool = definePortableTool({
  name: "details_only",
  title: "Details Only",
  description: "Returns legacy details without structured content.",
  parameters: emptyParams,
  execute() {
    return { text: "details", details: { source: "details" } };
  },
});

const throwingTool = definePortableTool({
  name: "throw_test",
  title: "Throw Test",
  description: "Throws for MCP error mapping tests.",
  parameters: emptyParams,
  execute() {
    throw new Error("boom from portable tool");
  },
});

const throwingStringTool = definePortableTool({
  name: "throw_string_test",
  title: "Throw String Test",
  description: "Throws a string for MCP error mapping tests.",
  parameters: emptyParams,
  execute() {
    throw "string boom from portable tool";
  },
});

test("MCP lists outputSchema and returns validated structured output", async () => {
  const outputSchema = Type.Object({ count: Type.Number() });
  const tool = definePortableTool({
    name: "output",
    title: "Output",
    description: "Declared structured output",
    parameters: emptyParams,
    outputSchema,
    execute: () => ({ text: "one", structuredContent: { count: 1 } }),
  });
  await withConnectedPair([tool], async (client) => {
    const list = await client.listTools();
    assert.deepEqual(list.tools[0]?.outputSchema, outputSchema);
    const result = await client.callTool({ name: tool.name, arguments: {} });
    assert.deepEqual(result.structuredContent, { count: 1 });
  });
});

test("MCP output schemas preserve error data and turn handler contract violations into failures", async () => {
  for (const result of [
    { text: "offline", structuredContent: { reason: "offline" }, isError: true },
    { text: "wrong", structuredContent: { count: "one" } },
    { text: "missing" },
  ]) {
    const execute: () => { text: string; structuredContent: { count: number } } = fromAny(() => result);
    const tool = definePortableTool({
      name: "output_error",
      title: "Output error",
      description: "Output contract failures",
      parameters: emptyParams,
      outputSchema: Type.Object({ count: Type.Number() }),
      execute,
    });
    await withConnectedPair([tool], async (client) => {
      await client.listTools();
      const returned = await client.callTool({ name: tool.name, arguments: {} });
      assert.equal(returned.isError, true);
      if (result.isError) {
        assert.deepEqual(returned.structuredContent, { reason: "offline" });
      } else {
        assert.match(textFromContent(returned.content), /Invalid structured output for output_error/);
      }
    });
  }
});

// A directly connected `Server` speaks the legacy era, where the SDK wraps a
// non-object root as `{ result }` on both `tools/list` and `tools/call`. The
// stdio integration tests pin the natural shape modern clients receive.
test("MCP lists non-object output schemas and returns their values wrapped for legacy clients", async () => {
  const cases = [
    { name: "array_output", outputSchema: Type.Array(Type.Number()), value: [1, 2, 3] },
    { name: "string_output", outputSchema: Type.String(), value: "plain" },
    { name: "null_output", outputSchema: Type.Null(), value: null },
    {
      name: "union_output",
      outputSchema: Type.Union([Type.Object({ ok: Type.Literal(true) }), Type.Object({ reason: Type.String() })]),
      value: { reason: "busy" },
    },
  ] as const;
  const tools = cases.map(({ name, outputSchema, value }) =>
    definePortableTool({
      name,
      title: name,
      description: "Non-object structured output",
      parameters: emptyParams,
      outputSchema,
      execute: () => ({ text: "value", structuredContent: value }),
    }),
  );
  await withConnectedPair(tools, async (client) => {
    const list = await client.listTools();
    for (const { name, outputSchema, value } of cases) {
      assert.deepEqual(list.tools.find((tool) => tool.name === name)?.outputSchema, {
        type: "object",
        properties: { result: outputSchema },
        required: ["result"],
      });
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { result: value });
      assert.deepEqual(result.content, [{ type: "text", text: "value" }]);
    }
  });
});

test("MCP intersections of objects still list and project with a synthesized object root", async () => {
  const outputSchema = Type.Intersect([Type.Object({ name: Type.String() }), Type.Object({ count: Type.Number() })]);
  const tool = definePortableTool({
    name: "intersect_output",
    title: "Intersect output",
    description: "Composed object output",
    parameters: emptyParams,
    outputSchema,
    execute: () => ({ text: "one", structuredContent: { name: "one", count: 1 } }),
  });
  await withConnectedPair([tool], async (client) => {
    const list = await client.listTools();
    assert.deepEqual(list.tools[0]?.outputSchema, { type: "object", ...outputSchema });
    const result = await client.callTool({ name: tool.name, arguments: {} });
    assert.deepEqual(result.structuredContent, { name: "one", count: 1 });
  });
});

test("MCP validates non-object structured output against the declared schema", async () => {
  const execute: () => { text: string; structuredContent: number[] } = fromAny(() => ({
    text: "wrong",
    structuredContent: ["one"],
  }));
  const tool = definePortableTool({
    name: "array_output_error",
    title: "Array output error",
    description: "Violates an array output schema",
    parameters: emptyParams,
    outputSchema: Type.Array(Type.Number()),
    execute,
  });
  await withConnectedPair([tool], async (client) => {
    const result = await client.callTool({ name: tool.name, arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textFromContent(result.content), /Invalid structured output for array_output_error/);
  });
});

test("MCP server lists tools with TypeBox schemas passed through unchanged", async () => {
  await withConnectedPair([echoTool, detailsOnlyTool], async (client) => {
    const list = await client.listTools();
    assert.deepEqual(
      list.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      [
        {
          name: "echo_test",
          title: "Echo Test",
          description: "Echo text for MCP tests.",
          inputSchema: echoParams,
        },
        {
          name: "details_only",
          title: "Details Only",
          description: "Returns legacy details without structured content.",
          inputSchema: emptyParams,
        },
      ],
    );
  });
});

test("MCP tool call returns structuredContent and host=mcp in context", async () => {
  let calls = 0;
  let observedHost: string | undefined;
  const observingEchoTool = definePortableTool({
    name: "echo_observing",
    title: "Echo Observing",
    description: "Captures ctx.host while echoing.",
    parameters: echoParams,
    execute(args, ctx) {
      calls += 1;
      observedHost = ctx.host;
      const output = args.uppercase ? args.text.toUpperCase() : args.text;
      return { text: output, structuredContent: { input: args.text, output } };
    },
  });

  await withConnectedPair([observingEchoTool], async (client) => {
    const result = await client.callTool({
      name: "echo_observing",
      arguments: { text: "hello", uppercase: true },
    });
    assert.equal(calls, 1);
    assert.equal(observedHost, "mcp");
    assert.deepEqual(result.content, [{ type: "text", text: "HELLO" }]);
    assert.deepEqual(result.structuredContent, { input: "hello", output: "HELLO" });
    assert.equal(result.isError, false);
  });
});

test("MCP tool call falls back to details when structuredContent is absent", async () => {
  await withConnectedPair([detailsOnlyTool], async (client) => {
    const result = await client.callTool({ name: "details_only", arguments: {} });
    assert.equal(textFromContent(result.content), "details");
    assert.deepEqual(result.structuredContent, { source: "details" });
    assert.equal(result.isError, false);
  });
});

test("MCP tool call surfaces a thrown Error as isError result", async () => {
  await withConnectedPair([throwingTool], async (client) => {
    const result = await client.callTool({ name: "throw_test", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textFromContent(result.content), /boom from portable tool/);
  });
});

test("MCP tool call surfaces a thrown non-Error value as isError result", async () => {
  await withConnectedPair([throwingStringTool], async (client) => {
    const result = await client.callTool({ name: "throw_string_test", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textFromContent(result.content), /string boom from portable tool/);
  });
});

test("MCP tool call with invalid args is rejected without invoking the portable handler", async () => {
  let calls = 0;
  const guardedEchoTool = definePortableTool({
    name: "echo_guarded",
    title: "Echo Guarded",
    description: "Counts invocations.",
    parameters: echoParams,
    execute(args) {
      calls += 1;
      return { text: args.text };
    },
  });

  await withConnectedPair([guardedEchoTool], async (client) => {
    const result = await client.callTool({ name: "echo_guarded", arguments: { text: 123 } });
    assert.equal(calls, 0, "invalid arguments must not call the portable tool handler");
    assert.equal(result.isError, true);
    const errors = structuredContent(result).validationErrors as Array<{ field: string; message: string }>;
    assert.equal(structuredContent(result).tool, "echo_guarded");
    assert.ok(Array.isArray(errors));
    assert.equal(errors.at(0)?.field, "text");
    // Note: the exact wording of result.text is owned by the core test
    // (executePortableTool returns validation errors without calling the tool).
  });
});

test("MCP server returns isError for an unknown tool name", async () => {
  await withConnectedPair([echoTool], async (client) => {
    const result = await client.callTool({ name: "missing_tool", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textFromContent(result.content), /Unknown tool: missing_tool/);
  });
});

test("MCP server propagates an AbortSignal to ctx.signal", async () => {
  let observedSignal: AbortSignal | undefined;
  const signalTool = definePortableTool({
    name: "signal_observe",
    title: "Signal Observe",
    description: "Captures ctx.signal.",
    parameters: emptyParams,
    execute(_args, ctx) {
      observedSignal = ctx.signal;
      return { text: "ok" };
    },
  });

  await withConnectedPair([signalTool], async (client) => {
    const controller = new AbortController();
    await client.callTool({ name: "signal_observe", arguments: {} }, { signal: controller.signal });
    assert.ok(observedSignal instanceof AbortSignal);
    assert.equal(observedSignal.aborted, false);
  });
});

test("MCP server aborts ctx.signal when the client cancels mid-call", async () => {
  let capturedSignal: AbortSignal | undefined;
  let resolveStarted: () => void = () => {};
  const toolStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let resolveSawAbort: () => void = () => {};
  const sawAbort = new Promise<void>((resolve) => {
    resolveSawAbort = resolve;
  });
  const longRunningTool = definePortableTool({
    name: "long_running",
    title: "Long Running",
    description: "Resolves only after its ctx.signal aborts.",
    parameters: emptyParams,
    async execute(_args, ctx) {
      capturedSignal = ctx.signal;
      resolveStarted();
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve();
          return;
        }
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      resolveSawAbort();
      return { text: "aborted" };
    },
  });

  await withConnectedPair([longRunningTool], async (client) => {
    const controller = new AbortController();
    const callPromise = client
      .callTool({ name: "long_running", arguments: {} }, { signal: controller.signal })
      .catch((error) => error);
    await toolStarted;
    assert.ok(capturedSignal instanceof AbortSignal);
    assert.equal(capturedSignal.aborted, false);
    controller.abort();
    await sawAbort;
    assert.equal(capturedSignal.aborted, true);
    await callPromise;
  });
});

test("MCP server maps ctx.progress to notifications/progress when the client sends a progressToken", async () => {
  const progressTool = definePortableTool({
    name: "progress_test",
    title: "Progress Test",
    description: "Emits two progress updates before finishing.",
    parameters: emptyParams,
    execute(_args, ctx) {
      ctx.progress?.({ text: "step one", structuredContent: { phase: 1 } });
      ctx.progress?.({ text: "step two" });
      return { text: "done", structuredContent: { steps: 2 } };
    },
  });
  await withConnectedPair([progressTool], async (client) => {
    const clientErrors: Error[] = [];
    client.onerror = (error) => clientErrors.push(error);
    const received: unknown[] = [];
    const result = await client.callTool(
      { name: "progress_test", arguments: {} },
      { onprogress: (progress) => received.push(progress) },
    );
    assert.deepEqual(result.structuredContent, { steps: 2 });
    assert.deepEqual(received, [
      { progress: 1, message: "step one" },
      { progress: 2, message: "step two" },
    ]);
    assert.deepEqual(clientErrors, []);
  });
});

test("MCP server sends no progress notifications when the request carries no progressToken", async () => {
  let sawProgressCallback: boolean | undefined;
  const progressTool = definePortableTool({
    name: "progress_silent",
    title: "Progress Silent",
    description: "Emits progress that nobody asked for.",
    parameters: emptyParams,
    execute(_args, ctx) {
      sawProgressCallback = ctx.progress !== undefined;
      ctx.progress?.({ text: "ignored" });
      return { text: "done" };
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sentMethods: string[] = [];
  const originalSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    if ("method" in message) sentMethods.push(message.method);
    return originalSend(message, options);
  };
  const server = createMcpServer({ name: "progress-test", version: "0.0.0", tools: [progressTool] });
  const client = new Client({ name: "progress-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "progress_silent", arguments: {} });
    assert.equal(textFromContent(result.content), "done");
    assert.equal(sawProgressCallback, false, "ctx.progress must be absent without a progressToken");
    assert.equal(sentMethods.includes("notifications/progress"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP server forwards configured instructions to the client", async () => {
  await withConnectedPair(
    [echoTool],
    async (client) => {
      assert.equal(client.getInstructions(), "Specific instructions for forwarding test.");
    },
    { instructions: "Specific instructions for forwarding test." },
  );
});
