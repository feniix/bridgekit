import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool } from "@feniix/bridgekit";
import { type PiToolRegistration, registerPiTools } from "@feniix/bridgekit/pi";
import { Type } from "typebox";

test("Pi forwards outputSchema and structuredContent while retaining details", async () => {
  const registered: Array<Parameters<PiToolRegistration["registerTool"]>[0]> = [];
  const outputSchema = Type.Object({ count: Type.Number() });
  registerPiTools({ registerTool: (tool) => registered.push(tool) }, [
    definePortableTool({
      name: "pi_output",
      title: "Pi output",
      description: "Structured output",
      parameters: Type.Object({}),
      outputSchema,
      execute: () => ({ text: "one", structuredContent: { count: 1 }, details: { ignored: true } }),
    }),
  ]);
  const tool = registered[0];
  assert.ok(tool);
  assert.equal(tool.outputSchema, outputSchema);
  const result = await tool.execute("id", {});
  assert.deepEqual(result.structuredContent, { count: 1 });
  assert.deepEqual(result.details, { count: 1 });
});
