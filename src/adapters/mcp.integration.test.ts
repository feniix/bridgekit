import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, type PortableTool } from "@feniix/bridgekit";
import { type CreateMcpServerOptions, createMcpServer } from "@feniix/bridgekit/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type TObject, Type } from "typebox";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
  uppercase: Type.Optional(Type.Boolean({ description: "Whether to uppercase the text." })),
});

const emptyParams = Type.Object({});

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
  tools: ReadonlyArray<PortableTool<TObject>>,
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
    const errors = structuredContent(result).validationErrors as Array<{ path: string; message: string }>;
    assert.equal(structuredContent(result).tool, "echo_guarded");
    assert.ok(Array.isArray(errors));
    assert.equal(errors[0].path, "/text");
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
    await client.callTool({ name: "signal_observe", arguments: {} }, undefined, { signal: controller.signal });
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
      .callTool({ name: "long_running", arguments: {} }, undefined, { signal: controller.signal })
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

test("MCP server forwards configured instructions to the client", async () => {
  await withConnectedPair(
    [echoTool],
    async (client) => {
      assert.equal(client.getInstructions(), "Specific instructions for forwarding test.");
    },
    { instructions: "Specific instructions for forwarding test." },
  );
});
