import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { definePortableTool } from "@feniix/bridgekit";
import { createMcpHttpHandler } from "@feniix/bridgekit/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Type } from "typebox";

const tools = [
  definePortableTool({
    name: "echo",
    title: "Echo",
    description: "Echo over HTTP",
    parameters: Type.Object({ text: Type.String() }),
    outputSchema: Type.Object({ text: Type.String() }),
    hostExtras: { mcp: { icons: [{ src: "https://example.com/icon.svg" }], _meta: { category: "text" } } },
    execute: (args) => ({ text: args.text, structuredContent: { text: args.text } }),
  }),
];

for (const modern of [false, true]) {
  test(`HTTP handler serves ${modern ? "modern" : "legacy"} clients over a real listener`, {
    timeout: 15000,
  }, async () => {
    const handler = createMcpHttpHandler({ name: "http-test", version: "0.0.0", tools });
    const listener = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const method = incoming.method ?? "GET";
        const response = await handler.fetch(
          new Request(`http://127.0.0.1${incoming.url}`, {
            method,
            headers,
            ...(method === "POST" && { body: Buffer.concat(chunks).toString() }),
          }),
        );
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(await response.text());
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address && typeof address !== "string");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const client = new Client(
      { name: "http-client", version: "0.0.0" },
      { versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" } },
    );
    const transport = new StreamableHTTPClientTransport(url);
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
      const list = await client.listTools();
      assert.deepEqual(list.tools[0]?.icons, [{ src: "https://example.com/icon.svg" }]);
      assert.deepEqual(list.tools[0]?._meta, { category: "text" });
      const result = await client.callTool({ name: "echo", arguments: { text: "http" } });
      assert.deepEqual(result.structuredContent, { text: "http" });
      const invalid = await client.callTool({ name: "echo", arguments: { text: 42 } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
      await transport.close();
      await handler.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

test("HTTP construction validates tools before returning a handler", () => {
  assert.throws(
    () =>
      createMcpHttpHandler({
        name: "bad",
        version: "0",
        tools: [
          definePortableTool({
            name: "bad",
            title: "Bad",
            description: "Bad",
            parameters: Type.String(),
            execute: (text) => ({ text }),
          }),
        ],
      }),
    /non-object parameters schema/,
  );
});

test("HTTP options can reject legacy clients and bound request bodies", async () => {
  const handler = createMcpHttpHandler(
    { name: "modern-only", version: "0", tools },
    { legacy: "reject", maxRequestBodySize: 256 },
  );
  try {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "0" } },
        }),
      }),
    );
    assert.match(await response.text(), /unsupported|Unsupported/);
    const oversized = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(257),
      }),
    );
    assert.equal(oversized.status, 413);
  } finally {
    await handler.close();
  }
});
