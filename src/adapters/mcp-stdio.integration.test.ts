import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";

const modernEnvelope = { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: {} };
const withEnvelope = (params: Record<string, unknown>) => ({ ...params, _meta: modernEnvelope });

const fixture = fileURLToPath(new URL("../../../scripts/mcp-stdio-fixture.mjs", import.meta.url));

for (const active of [false, true]) {
  test(`stdio close handle shuts down ${active ? "an active request" : "before negotiation"}`, {
    timeout: 15000,
  }, async () => {
    const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    assert.ok(child.stdout);
    assert.ok(child.stdin);
    const exited = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    try {
      const [ready] = await once(child, "message");
      assert.deepEqual(ready, { ready: true });
      if (active) {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "wait",
              arguments: {},
              _meta: { ...modernEnvelope, progressToken: "started" },
            },
          })}\n`,
        );
        const started = await replies.next();
        assert.equal(started.done, false);
        assert.equal(JSON.parse(started.value ?? "").method, "notifications/progress");
      }
      const closed = once(child, "message");
      child.send("close");
      assert.deepEqual((await closed)[0], { closed: true, aborted: active });
      assert.deepEqual(await exited, [0, null]);
      assert.equal((await replies.next()).done, true, "no result should be written after closure");
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
}

test("discarded modern discover probes do not affect a later modern session", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: withEnvelope(params) })}\n`);
    const next = await replies.next();
    assert.equal(next.done, false);
    const reply: { id: number; error?: unknown; result: Record<string, unknown> } = JSON.parse(next.value ?? "");
    assert.equal(reply.id, id);
    assert.equal(reply.error, undefined);
    return reply.result;
  };
  try {
    for (let probe = 0; probe < 3; probe++) {
      const discovery = await request("server/discover", {});
      assert.ok(discovery.supportedVersions);
    }
    const listing = await request("tools/list", {});
    assert.ok(Array.isArray(listing.tools));
    const echo = listing.tools.find((tool) => tool.name === "echo");
    assert.deepEqual(echo.icons, [{ src: "https://example.com/original.svg" }]);
    assert.deepEqual(echo._meta, { category: "original" });
    assert.ok(!listing.tools.some((tool) => tool.name === "late-invalid"));
    const result = await request("tools/call", { name: "echo", arguments: { text: "fallback" } });
    assert.deepEqual(result.structuredContent, { text: "fallback" });
    // A synchronous progress burst is written in order and before the result.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: {
          name: "progress",
          arguments: { burst: true },
          _meta: { ...modernEnvelope, progressToken: "tok" },
        },
      })}\n`,
    );
    const burst: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await replies.next();
      assert.equal(next.done, false);
      burst.push(JSON.parse(next.value ?? ""));
    }
    assert.deepEqual(burst.slice(0, 2), [
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "tok", progress: 1, message: "first" },
      },
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "tok", progress: 2, message: "second" },
      },
    ]);
    // Pin the full wire shape: no stray keys beyond the modern-era stamp.
    assert.deepEqual(burst[2], {
      jsonrpc: "2.0",
      id,
      result: {
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "stdio-fixture", version: "0.0.0" } },
        content: [{ type: "text", text: "done" }],
        structuredContent: { steps: 2 },
        isError: false,
        resultType: "complete",
      },
    });
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

test("default-constructed SDK v2 client is refused (its default negotiation mode is legacy)", {
  timeout: 15000,
}, async () => {
  const client = new Client({ name: "default-client", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture], stderr: "pipe" });
  try {
    await assert.rejects(client.connect(transport), {
      code: -32022,
      message: /Unsupported protocol version: 2025-11-25/,
    });
  } finally {
    await client.close();
    await transport.close();
  }
});

test("SDK client in legacy negotiation mode is refused with the supported modern revisions", {
  timeout: 15000,
}, async () => {
  const client = new Client({ name: "legacy-client", version: "0.0.0" }, { versionNegotiation: { mode: "legacy" } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fixture], stderr: "pipe" });
  try {
    await assert.rejects(client.connect(transport), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Unsupported protocol version: 2025-11-25/);
      assert.deepEqual(Object.getOwnPropertyDescriptor(error, "data")?.value, {
        supported: ["2026-07-28"],
        requested: "2025-11-25",
      });
      return true;
    });
  } finally {
    await client.close();
    await transport.close();
  }
});

test("legacy 2025-11-25 initialize is rejected and the connection stays usable for modern clients", {
  timeout: 15000,
}, async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  try {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "old-client", version: "0.0.0" },
        },
      })}\n`,
    );
    const rejected: { id: number; result?: unknown; error?: { code: number; data?: unknown } } = JSON.parse(
      (await replies.next()).value ?? "",
    );
    assert.equal(rejected.id, 1);
    assert.equal(rejected.result, undefined);
    assert.ok(rejected.error, "legacy initialize must be answered with an error");
    assert.equal(rejected.error.code, -32022);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: withEnvelope({}) })}\n`);
    const listing: { id: number; error?: unknown; result?: { tools?: unknown[] } } = JSON.parse(
      (await replies.next()).value ?? "",
    );
    assert.equal(listing.id, 2);
    assert.equal(listing.error, undefined);
    assert.ok(Array.isArray(listing.result?.tools));
  } finally {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

for (const mode of ["auto", "modern-pinned"] as const) {
  test(`public stdio runner serves ${mode} modern clients`, { timeout: 15000 }, async () => {
    const client = new Client(
      { name: "modern-client", version: "0.0.0" },
      {
        versionNegotiation: {
          mode: mode === "modern-pinned" ? { pin: "2026-07-28" } : mode,
          probe: { timeoutMs: 2000 },
        },
      },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixture],
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), "modern");
      const list = await client.listTools();
      assert.equal(list.tools[0]?.inputSchema.type, "object");
      assert.equal(list.tools[0]?.outputSchema?.type, "object");
      const result = await client.callTool({ name: "echo", arguments: { text: "modern" } });
      assert.deepEqual(result.structuredContent, { text: "modern" });
      // Non-object roots carry their natural value on the modern era.
      const listOutput = list.tools.find((tool) => tool.name === "list_output")?.outputSchema;
      const arraySchema = { type: "array", items: { type: "number" } };
      assert.deepEqual(listOutput, arraySchema);
      const listResult = await client.callTool({ name: "list_output", arguments: {} });
      assert.deepEqual(listResult.structuredContent, [1, 2, 3]);
      const progressUpdates: unknown[] = [];
      const progressResult = await client.callTool(
        { name: "progress", arguments: {} },
        { onprogress: (progress) => progressUpdates.push(progress) },
      );
      assert.deepEqual(progressResult.structuredContent, { steps: 2 });
      assert.deepEqual(progressUpdates, [
        { progress: 1, message: "first" },
        { progress: 2, message: "second" },
      ]);
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

test("EOF aborts an active timer-holding modern tool", { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const closed = once(child, "close", { signal: t.signal });
  // A timeout can reject this before the readline drain finishes. Observe it
  // immediately; awaiting the original promise below still propagates errors.
  void closed.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const ids: number[] = [];
  const envelope = { _meta: modernEnvelope };
  const send = (id: number, method: string, params: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const reply = async () => {
    const next = await replies.next();
    assert.equal(next.done, false);
    const result: { id: number; error?: unknown; result: Record<string, unknown> } = JSON.parse(next.value ?? "");
    ids.push(result.id);
    assert.equal(result.error, undefined);
    return result;
  };
  try {
    send(2, "tools/call", { name: "wait", arguments: {}, ...envelope });
    send(3, "tools/call", { name: "status", arguments: {}, ...envelope });
    const status = await reply();
    assert.equal(status.id, 3);
    assert.deepEqual(status.result.structuredContent, { started: true, aborted: false });
    // Drain the iterator after EOF as well, so a stray pending-tool response
    // cannot escape the no-post-EOF-response assertion.
    child.stdin.end();
    for await (const line of replies) {
      const response: { id?: number } = JSON.parse(line);
      if (response.id !== undefined) ids.push(response.id);
    }
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(ids.includes(2), false);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
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

test("stdio opening JSON-RPC validation errors are diagnosed on stderr, never stdout", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data;
  });
  try {
    const closed = once(child, "close");
    child.stdin.end(`${JSON.stringify({ jsonrpc: "invalid", id: 1, method: "tools/list" })}\n`);
    await closed;
    assert.equal(stdout, "");
    assert.match(stderr, /\[bridgekit-mcp\]/);
    assert.match(stderr, /jsonrpc/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
