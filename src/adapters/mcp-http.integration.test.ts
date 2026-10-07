import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { definePortableTool, type PortableTool } from "@feniix/bridgekit";
import { createMcpHttpHandler } from "@feniix/bridgekit/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { fromAny } from "@total-typescript/shoehorn";
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
    const nodeHandler = toNodeHandler(handler);
    const validHost = localhostHostValidation();
    const validOrigin = localhostOriginValidation();
    const listener = createServer((incoming, outgoing) => {
      if (!validHost(incoming, outgoing) || !validOrigin(incoming, outgoing)) return;
      void nodeHandler(fromAny(incoming), outgoing).catch((error: unknown) => {
        if (outgoing.headersSent) outgoing.destroy();
        else outgoing.writeHead(500).end(String(error));
      });
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

for (const modern of [false, true]) {
  test(`HTTP snapshots caller options across ${modern ? "modern" : "legacy"} requests`, async () => {
    const icon = { src: "https://example.com/original.svg" };
    const meta = { category: "original" };
    const mutableTools: PortableTool[] = [
      definePortableTool({
        name: "original",
        title: "Original",
        description: "Original",
        parameters: Type.Object({}),
        hostExtras: { mcp: { icons: [icon], _meta: meta } },
        execute: () => ({ text: "original" }),
      }),
    ];
    const options = { name: "snapshot", version: "0", tools: mutableTools };
    const handler = createMcpHttpHandler(options);
    icon.src = "mutated";
    meta.category = "mutated";
    options.name = "mutated";
    mutableTools.push(
      definePortableTool({
        name: "late",
        title: "Late",
        description: "Late",
        parameters: Type.String(),
        execute: () => ({ text: "late" }),
      }),
    );
    const client = new Client(
      { name: "snapshot-client", version: "0" },
      {
        versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, "snapshot");
      for (let i = 0; i < 2; i++) {
        const list = await client.listTools();
        assert.deepEqual(
          list.tools.map((tool) => tool.name),
          ["original"],
        );
        assert.deepEqual(list.tools[0]?.icons, [{ src: "https://example.com/original.svg" }]);
        assert.deepEqual(list.tools[0]?._meta, { category: "original" });
        assert.equal((await client.callTool({ name: "original", arguments: {} })).isError, false);
        assert.equal((await client.callTool({ name: "late", arguments: {} })).isError, true);
      }
    } finally {
      await client.close();
      await transport.close();
      await handler.close();
    }
  });
}

test("HTTP diagnostics default to stderr and honor a caller reporter", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (text: string) => {
    diagnostics.push(text);
    return true;
  });
  for (const custom of [false, true]) {
    const reported: Error[] = [];
    const handler = createMcpHttpHandler(
      { name: "diagnostics", version: "0", tools },
      {
        legacy: "reject",
        ...(custom && {
          onerror: (error: Error) => {
            reported.push(error);
          },
        }),
      },
    );
    try {
      await handler.fetch(
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
      if (custom) {
        assert.equal(reported.length, 1);
        assert.equal(diagnostics.length, 1);
      } else {
        assert.equal(diagnostics.length, 1);
        assert.match(diagnostics[0] ?? "", /^\[bridgekit-mcp\]/);
      }
    } finally {
      await handler.close();
    }
  }
});
