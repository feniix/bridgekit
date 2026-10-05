import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fromAny } from "@total-typescript/shoehorn";

const fixture = path.resolve("scripts/mcp-stdio-fixture.mjs");

for (const modern of [false, true]) {
  test(`public stdio runner serves ${modern ? "modern-pinned" : "legacy"} clients`, { timeout: 15000 }, async () => {
    const client = new Client(
      { name: "modern-client", version: "0.0.0" },
      { versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy", probe: { timeoutMs: 2000 } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
      const list = await client.listTools();
      assert.equal(list.tools[0]?.inputSchema.type, "object");
      assert.equal(list.tools[0]?.outputSchema?.type, "object");
      const result = await client.callTool({ name: "echo", arguments: { text: "modern" } });
      assert.deepEqual(result.structuredContent, { text: "modern" });
      const domain = await client.callTool({ name: "domain", arguments: {} });
      assert.equal(domain.isError, true);
      assert.deepEqual(domain.structuredContent, { reason: "offline" });
      for (const name of ["throws", "invalid_output", "missing"]) {
        const failure = await client.callTool({ name, arguments: {} });
        assert.equal(failure.isError, true);
      }
      const invalid = await client.callTool({ name: "echo", arguments: { text: 42 } });
      assert.equal(invalid.isError, true);
      const validation: { kind: string } = fromAny(invalid.structuredContent);
      assert.equal(validation.kind, "validation");

      const controller = new AbortController();
      const pending = client.callTool({ name: "wait", arguments: {} }, { signal: controller.signal }).then(
        () => false,
        () => true,
      );
      const waitForStatus = async (key: "started" | "aborted") => {
        for (let attempt = 0; attempt < 50; attempt++) {
          const status = await client.callTool({ name: "status", arguments: {} });
          const data: Record<string, unknown> = fromAny(status.structuredContent);
          if (data[key] === true) return;
          await setTimeout(10);
        }
        assert.fail(`wait tool never reported ${key}`);
      };
      await waitForStatus("started");
      controller.abort();
      assert.equal(await pending, true);
      await waitForStatus("aborted");
    } finally {
      await client.close();
      await transport.close();
    }
  });
}

test("SDK v1 client can use the dual-era public runner", { timeout: 15000 }, async () => {
  const client = new LegacyClient({ name: "sdk-v1-client", version: "0.0.0" });
  const transport = new LegacyTransport({ command: process.execPath, args: [fixture], stderr: "pipe" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools[0]?.outputSchema?.type, "object");
    const result = await client.callTool({ name: "echo", arguments: { text: "legacy" } });
    assert.deepEqual(result.structuredContent, { text: "legacy" });
  } finally {
    await client.close();
    await transport.close();
  }
});

test("stdio runner exits cleanly when stdin closes", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    child.stdin.end();
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
