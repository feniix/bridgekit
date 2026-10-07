// Spawned only by stdio integration tests, never imported by library entrypoints.

import { setTimeout as sleep } from "node:timers/promises";
import { definePortableTool } from "@feniix/bridgekit";
import { runMcpStdioServer } from "@feniix/bridgekit/mcp";
import { Type } from "typebox";

let started = false;
let aborted = false;
const outputSchema = Type.Object({ text: Type.String() });
const simpleTool = (name, execute) =>
  definePortableTool({
    name,
    title: name,
    description: name,
    parameters: Type.Object({}),
    outputSchema,
    execute,
  });

const handle = await runMcpStdioServer({
  name: "stdio-fixture",
  version: "0.0.0",
  tools: [
    definePortableTool({
      name: "echo",
      title: "Echo",
      description: "Echo with declared output.",
      parameters: Type.Intersect([Type.Object({ text: Type.String() }), Type.Object({})]),
      outputSchema,
      execute: (args) => ({ text: args.text, structuredContent: { text: args.text } }),
    }),
    simpleTool("domain", () => ({ text: "offline", structuredContent: { reason: "offline" }, isError: true })),
    simpleTool("throws", () => {
      throw new Error("unexpected fixture failure");
    }),
    simpleTool("invalid_output", () => ({ text: "wrong", structuredContent: { text: 42 } })),
    simpleTool("wait", async (_args, ctx) => {
      started = true;
      ctx.progress?.({ text: "started" });
      // EOF tests must prove abort-driven cleanup, not natural process exit
      // from an unresolved Promise that holds no event-loop resource.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        await new Promise((resolve) => {
          if (ctx.signal?.aborted) resolve();
          else ctx.signal?.addEventListener("abort", resolve, { once: true });
        });
        aborted = true;
        return { text: "cancelled", isError: true };
      } finally {
        clearInterval(keepAlive);
      }
    }),
    definePortableTool({
      name: "list_output",
      title: "List output",
      description: "Array-rooted structured output.",
      parameters: Type.Object({}),
      outputSchema: Type.Array(Type.Number()),
      execute: () => ({ text: "[1,2,3]", structuredContent: [1, 2, 3] }),
    }),
    definePortableTool({
      name: "progress",
      title: "Progress",
      description: "Emits two progress updates over time, like a long-running tool.",
      parameters: Type.Object({ burst: Type.Optional(Type.Boolean()) }),
      execute: async (args, ctx) => {
        // Spaced updates reach SDK clients' onprogress; a synchronous burst
        // is still serialized in order on the wire (pinned by the raw test).
        ctx.progress?.({ text: "first" });
        if (!args.burst) await sleep(20);
        ctx.progress?.({ text: "second", structuredContent: { phase: 2 } });
        if (!args.burst) await sleep(20);
        return { text: "done", structuredContent: { steps: 2 } };
      },
    }),
    definePortableTool({
      name: "status",
      title: "Status",
      description: "Observe cancellation through a public tool.",
      parameters: Type.Object({}),
      execute: () => ({ text: "status", structuredContent: { started, aborted } }),
    }),
  ],
});

// IPC is used only by lifecycle tests; normal stdio consumers never see it.
if (process.send) {
  process.on("message", async (message) => {
    if (message !== "close") return;
    await Promise.all([handle.close(), handle.close()]);
    process.send?.({ closed: true, aborted });
    process.disconnect();
  });
  process.send({ ready: true });
}
