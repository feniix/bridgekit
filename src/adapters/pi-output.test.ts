import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool } from "@feniix/bridgekit";
import { type PiToolRegistration, registerPiTools } from "@feniix/bridgekit/pi";
import { fromAny } from "@total-typescript/shoehorn";
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

test("Pi validates every output schema before registering any tools", () => {
  const registered: Array<Parameters<PiToolRegistration["registerTool"]>[0]> = [];
  const makeTool = (name: string, outputSchema: ReturnType<typeof Type.Object> | ReturnType<typeof Type.Ref>) =>
    definePortableTool({
      name,
      title: name,
      description: name,
      parameters: Type.Object({}),
      outputSchema,
      execute: () => ({ text: "ok", structuredContent: {} }),
    });
  assert.throws(
    () =>
      registerPiTools({ registerTool: (tool) => registered.push(tool) }, [
        makeTool("valid", Type.Object({})),
        makeTool("invalid", Type.Ref("Output")),
      ]),
    /Invalid outputSchema for invalid/,
  );
  assert.deepEqual(registered, []);
});

test("Pi preserves domain error data outside success schemas and surfaces invalid output as failure", async () => {
  for (const output of [
    { text: "offline", structuredContent: { reason: "offline" }, isError: true },
    { text: "wrong", structuredContent: { count: "one" } },
  ]) {
    const execute: () => { text: string; structuredContent: { count: number } } = fromAny(() => output);
    const registered: Array<Parameters<PiToolRegistration["registerTool"]>[0]> = [];
    registerPiTools({ registerTool: (tool) => registered.push(tool) }, [
      definePortableTool({
        name: "pi_output_error",
        title: "Pi error",
        description: "Output error",
        parameters: Type.Object({}),
        outputSchema: Type.Object({ count: Type.Number() }),
        execute,
      }),
    ]);
    const tool = registered[0];
    assert.ok(tool);
    const result = await tool.execute("id", {});
    assert.equal(result.isError, true);
    if (output.isError) {
      assert.deepEqual(result.structuredContent, { reason: "offline" });
      assert.deepEqual(result.details, { reason: "offline" });
    } else {
      assert.match(result.content[0]?.text ?? "", /Invalid structured output for pi_output_error/);
    }
  }
});

test("Pi passes non-object structuredContent through and wraps it as details.result", async () => {
  const registered: Array<Parameters<PiToolRegistration["registerTool"]>[0]> = [];
  registerPiTools({ registerTool: (tool) => registered.push(tool) }, [
    definePortableTool({
      name: "pi_array_output",
      title: "Pi array output",
      description: "Array-rooted structured output",
      parameters: Type.Object({}),
      outputSchema: Type.Array(Type.Number()),
      execute: (_args, ctx) => {
        ctx.progress?.({ text: "partial", structuredContent: [1] });
        return { text: "[1,2,3]", structuredContent: [1, 2, 3] };
      },
    }),
    definePortableTool({
      name: "pi_null_output",
      title: "Pi null output",
      description: "Null structured output",
      parameters: Type.Object({}),
      execute: () => ({ text: "nothing", structuredContent: null, details: { ignored: true } }),
    }),
  ]);
  const [arrayTool, nullTool] = registered;
  assert.ok(arrayTool);
  assert.ok(nullTool);
  const updates: unknown[] = [];
  const result = await arrayTool.execute("id", {}, undefined, (update) => updates.push(update));
  assert.deepEqual(updates, [{ content: [{ type: "text", text: "partial" }], details: { result: [1] } }]);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "[1,2,3]" }],
    details: { result: [1, 2, 3] },
    structuredContent: [1, 2, 3],
    isError: false,
  });
  // `null` is a value, not an absence: legacy `details` must not win.
  const nullResult = await nullTool.execute("id", {});
  assert.deepEqual(nullResult.details, { result: null });
  assert.equal(nullResult.structuredContent, null);
});
