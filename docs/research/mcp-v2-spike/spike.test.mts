import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1Transport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

for (const mode of ["legacy", "auto", "modern"] as const) {
  test(`low-level TypeBox adapter over ${mode} stdio`, { timeout: 15000 }, async () => {
    const client = new Client(
      { name: "spike-client", version: "0.0.0" },
      {
        versionNegotiation: {
          mode: mode === "modern" ? { pin: "2026-07-28" } : mode,
          probe: { timeoutMs: 2000, maxRetries: 0 },
        },
      },
    );
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: "pipe" });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === "legacy" ? "legacy" : "modern");
      const list = await client.listTools();
      assert.deepEqual(list.tools[0]?.inputSchema, {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      });
      const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, { text: "hello", host: "mcp", signal: true });
      const invalid = await client.callTool({ name: "echo", arguments: { text: 1 } });
      assert.equal(invalid.isError, true);
      assert.equal((invalid.structuredContent as { kind: string }).kind, "validation");
      const array = await client.callTool({ name: "array", arguments: {} });
      assert.deepEqual(array.structuredContent, mode === "legacy" ? { result: ["a", "b"] } : ["a", "b"]);
      const missing = await client.callTool({ name: "missing", arguments: {} });
      assert.equal(missing.isError, true);
    } finally {
      await client.close();
      await transport.close();
    }
  });
}

test("SDK v1 client interoperates with dual-era entry", { timeout: 15000 }, async () => {
  const client = new V1Client({ name: "v1-spike-client", version: "0.0.0" });
  const transport = new V1Transport({ command: process.execPath, args: [serverPath], stderr: "pipe" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools[1]?.outputSchema?.type, "object");
    const echo = await client.callTool({ name: "echo", arguments: { text: "v1" } });
    assert.deepEqual(echo.structuredContent, { text: "v1", host: "mcp", signal: true });
    const array = await client.callTool({ name: "array", arguments: {} });
    assert.deepEqual(array.structuredContent, { result: ["a", "b"] });
  } finally {
    await client.close();
    await transport.close();
  }
});

test("direct Server.connect remains legacy-only", { timeout: 15000 }, async () => {
  const client = new Client(
    { name: "spike-client", version: "0.0.0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" }, probe: { timeoutMs: 2000, maxRetries: 0 } },
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--direct"],
    stderr: "pipe",
  });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close();
    await transport.close();
  }
});

test("strict modern entry rejects legacy initialization", { timeout: 15000 }, async () => {
  const client = new Client({ name: "spike-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--strict"],
    stderr: "pipe",
  });
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close();
    await transport.close();
  }
});
