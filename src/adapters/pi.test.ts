import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool } from "@feniix/pi-portable-tools";
import {
  isPortableToolExecutionError,
  PortableToolExecutionError,
  registerPiTools,
} from "@feniix/pi-portable-tools/pi";
import { Type } from "typebox";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
  uppercase: Type.Optional(Type.Boolean({ description: "Whether to uppercase the text." })),
});

type RegisteredPiTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
};

test("registerPiTools registers every portable tool with pi metadata", () => {
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo text for pi tests.",
    parameters: echoParams,
    execute() {
      return { text: "ok" };
    },
  });
  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(pi as never, [echoTool]);

  assert.deepEqual(
    registered.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
    })),
    [
      {
        name: "echo_test",
        label: "Echo Test",
        description: "Echo text for pi tests.",
        parameters: echoParams,
      },
    ],
  );
});

test("registered pi tool delegates execution and maps progress updates", async () => {
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo text for pi tests.",
    parameters: echoParams,
    execute(args, ctx) {
      ctx.progress?.({
        text: "starting",
        structuredContent: { phase: "start" },
        details: { legacyPhase: "ignored" },
      });
      const output = args.uppercase ? args.text.toUpperCase() : args.text;
      return {
        text: output,
        structuredContent: { input: args.text, output },
        details: { legacyOutput: "ignored" },
      };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(pi as never, [echoTool]);
  const tool = registered.find((candidate) => candidate.name === "echo_test");
  assert.ok(tool);

  const updates: unknown[] = [];
  const result = await tool.execute(
    "tool-call-1",
    { text: "hello", uppercase: true },
    undefined,
    (update: unknown) => updates.push(update),
    {},
  );

  assert.deepEqual(updates, [{ content: [{ type: "text", text: "starting" }], details: { phase: "start" } }]);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "HELLO" }],
    details: { input: "hello", output: "HELLO" },
  });
});

test("registered pi tool maps details when structured content is absent", async () => {
  const detailsTool = definePortableTool({
    name: "details_test",
    title: "Details Test",
    description: "Details fallback test.",
    parameters: Type.Object({}),
    execute() {
      return { text: "details", details: { source: "details" } };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(pi as never, [detailsTool]);
  const tool = registered.find((candidate) => candidate.name === "details_test");
  assert.ok(tool);

  const result = await tool.execute("tool-call-details", {}, undefined, undefined, {});

  assert.deepEqual(result, {
    content: [{ type: "text", text: "details" }],
    details: { source: "details" },
  });
});

test("registered pi tool rejects invalid args without calling the portable handler", async () => {
  let called = false;
  const echoTool = definePortableTool({
    name: "echo_test",
    title: "Echo Test",
    description: "Echo text for pi tests.",
    parameters: echoParams,
    execute() {
      called = true;
      return { text: "should not run" };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(pi as never, [echoTool]);
  const tool = registered.find((candidate) => candidate.name === "echo_test");
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute("tool-call-invalid", { text: 42 }, undefined, undefined, {}),
    (error: unknown) => {
      assert.equal(called, false);
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.match(error.message, /Invalid arguments for echo_test/);
      assert.deepEqual(error.details.tool, "echo_test");
      assert.ok(Array.isArray(error.details.validationErrors));
      return true;
    },
  );
});
