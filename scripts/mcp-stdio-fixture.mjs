// Spawned only by stdio integration tests, never imported by library entrypoints.
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

await runMcpStdioServer({
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
      await new Promise((resolve) => {
        if (ctx.signal?.aborted) resolve();
        else ctx.signal?.addEventListener("abort", resolve, { once: true });
      });
      aborted = true;
      return { text: "cancelled", isError: true };
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
