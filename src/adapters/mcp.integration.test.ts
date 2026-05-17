import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { definePortableTool } from "@feniix/pi-portable-tools";
import { createMcpServer } from "@feniix/pi-portable-tools/mcp";

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

function structuredContent(result: unknown): Record<string, unknown> {
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  const content = (result as { structuredContent?: unknown }).structuredContent;
  assert.equal(typeof content, "object");
  assert.notEqual(content, null);
  return content as Record<string, unknown>;
}

test("MCP server lists and calls portable tools over a transport", async () => {
  let calls = 0;
  const observedSignals: Array<AbortSignal | undefined> = [];
  const detailsOnlyTool = definePortableTool({
    name: "details_only",
    title: "Details Only",
    description: "Returns legacy details without structured content.",
    parameters: emptyParams,
    execute() {
      return { text: "details", details: { source: "details" } };
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
  const throwingTool = definePortableTool({
    name: "throw_test",
    title: "Throw Test",
    description: "Throws for MCP error mapping tests.",
    parameters: emptyParams,
    execute() {
      throw new Error("boom from portable tool");
    },
  });
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo text for MCP tests.",
    parameters: echoParams,
    execute(args, ctx) {
      calls += 1;
      observedSignals.push(ctx.signal);
      const output = args.uppercase ? args.text.toUpperCase() : args.text;
      return { text: output, structuredContent: { input: args.text, output } };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    name: "portable-tools-test",
    version: "0.1.0",
    tools: [echoTool, detailsOnlyTool, throwingTool, throwingStringTool],
    instructions: "Use test tools.",
  });
  const client = new Client({ name: "portable-tools-test-client", version: "0.1.0" });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
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
        {
          name: "throw_test",
          title: "Throw Test",
          description: "Throws for MCP error mapping tests.",
          inputSchema: emptyParams,
        },
        {
          name: "throw_string_test",
          title: "Throw String Test",
          description: "Throws a string for MCP error mapping tests.",
          inputSchema: emptyParams,
        },
      ],
    );

    const requestController = new AbortController();
    const result = await client.callTool(
      {
        name: "echo_test",
        arguments: { text: "hello", uppercase: true },
      },
      undefined,
      { signal: requestController.signal },
    );
    assert.equal(calls, 1);
    assert.ok(observedSignals[0] instanceof AbortSignal);
    assert.equal(observedSignals[0]?.aborted, false);
    assert.deepEqual(result.content, [{ type: "text", text: "HELLO" }]);
    assert.deepEqual(result.structuredContent, { input: "hello", output: "HELLO" });
    assert.equal(result.isError, false);

    const detailsOnly = await client.callTool({ name: "details_only", arguments: {} });
    assert.equal(textFromContent(detailsOnly.content), "details");
    assert.deepEqual(detailsOnly.structuredContent, { source: "details" });
    assert.equal(detailsOnly.isError, false);

    const thrown = await client.callTool({ name: "throw_test", arguments: {} });
    assert.equal(thrown.isError, true);
    assert.match(textFromContent(thrown.content), /boom from portable tool/);

    const thrownString = await client.callTool({ name: "throw_string_test", arguments: {} });
    assert.equal(thrownString.isError, true);
    assert.match(textFromContent(thrownString.content), /string boom from portable tool/);

    const invalid = await client.callTool({
      name: "echo_test",
      arguments: { text: 123 },
    });
    assert.equal(calls, 1, "invalid arguments must not call the portable tool handler");
    assert.equal(invalid.isError, true);
    assert.match(textFromContent(invalid.content), /Invalid arguments for echo_test/);
    assert.deepEqual(structuredContent(invalid).tool, "echo_test");
    assert.ok(Array.isArray(structuredContent(invalid).validationErrors));

    const unknown = await client.callTool({ name: "missing_tool", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.match(textFromContent(unknown.content), /Unknown tool: missing_tool/);
  } finally {
    await client.close();
    await server.close();
  }
});
