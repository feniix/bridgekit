import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";
import { definePortableTool, executePortableTool } from "@feniix/pi-portable-tools";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
  uppercase: Type.Optional(Type.Boolean({ description: "Whether to uppercase the text." })),
});

type EchoParams = Static<typeof echoParams>;

test("executePortableTool runs valid TypeBox-inferred tool args", async () => {
  const calls: EchoParams[] = [];
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo test text.",
    parameters: echoParams,
    execute(args) {
      calls.push(args);
      const output = args.uppercase ? args.text.toUpperCase() : args.text;
      return { text: output, structuredContent: { output } };
    },
  });

  const result = await executePortableTool(echoTool, { text: "hello", uppercase: true }, { host: "test" });

  assert.deepEqual(calls, [{ text: "hello", uppercase: true }]);
  assert.deepEqual(result, { text: "HELLO", structuredContent: { output: "HELLO" } });
});

test("executePortableTool returns validation errors without calling the tool", async () => {
  let called = false;
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo test text.",
    parameters: echoParams,
    execute() {
      called = true;
      return { text: "should not run" };
    },
  });

  const result = await executePortableTool(echoTool, { text: 42 }, { host: "test" });

  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.match(result.text, /Invalid arguments for echo_test/);
  assert.deepEqual(result.structuredContent?.tool, "echo_test");
  assert.ok(Array.isArray(result.structuredContent?.validationErrors));
  assert.match(JSON.stringify(result.structuredContent?.validationErrors), /text/);
});
