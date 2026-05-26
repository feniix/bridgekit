import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool } from "@feniix/bridgekit";
import { isPortableToolExecutionError, PortableToolExecutionError, registerPiTools } from "@feniix/bridgekit/pi";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { Type } from "typebox";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
  uppercase: Type.Optional(Type.Boolean({ description: "Whether to uppercase the text." })),
});

type RegisteredPiTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
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

  registerPiTools(fromPartial(pi), [echoTool]);

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

  registerPiTools(fromPartial(pi), [echoTool]);
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
    isError: false,
  });
});

test("registered pi tool maps progress details when structured content is absent", async () => {
  const detailsProgressTool = definePortableTool({
    name: "details_progress_test",
    title: "Details Progress Test",
    description: "Progress details fallback test.",
    parameters: Type.Object({}),
    execute(_args, ctx) {
      ctx.progress?.({ text: "step", details: { phase: "details-only" } });
      return { text: "done" };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [detailsProgressTool]);
  const tool = registered.find((candidate) => candidate.name === "details_progress_test");
  assert.ok(tool);

  const updates: unknown[] = [];
  await tool.execute("tool-call-progress-details", {}, undefined, (update: unknown) => updates.push(update), {});

  assert.deepEqual(updates, [{ content: [{ type: "text", text: "step" }], details: { phase: "details-only" } }]);
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

  registerPiTools(fromPartial(pi), [detailsTool]);
  const tool = registered.find((candidate) => candidate.name === "details_test");
  assert.ok(tool);

  const result = await tool.execute("tool-call-details", {}, undefined, undefined, {});

  assert.deepEqual(result, {
    content: [{ type: "text", text: "details" }],
    details: { source: "details" },
    isError: false,
  });
});

test("registered pi tool forwards the AbortSignal and host to the portable context", async () => {
  let observedHost: string | undefined;
  let observedSignal: AbortSignal | undefined;
  const inspectTool = definePortableTool({
    name: "inspect_ctx",
    title: "Inspect Ctx",
    description: "Captures ctx for assertions.",
    parameters: Type.Object({}),
    execute(_args, ctx) {
      observedHost = ctx.host;
      observedSignal = ctx.signal;
      return { text: "ok" };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [inspectTool]);
  const tool = registered.find((candidate) => candidate.name === "inspect_ctx");
  assert.ok(tool);

  const controller = new AbortController();
  await tool.execute("tool-call-ctx", {}, controller.signal, undefined, {});

  assert.equal(observedHost, "pi");
  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal?.aborted, false);

  controller.abort();
  assert.equal(observedSignal?.aborted, true);
});

test("registered pi tool (default return mode): invalid args return isError=true without calling the handler", async () => {
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

  registerPiTools(fromPartial(pi), [echoTool]);
  const tool = registered.find((candidate) => candidate.name === "echo_test");
  assert.ok(tool);

  const result = await tool.execute("tool-call-invalid", { text: 42 }, undefined, undefined, {});
  assert.equal(called, false);
  assert.equal(result.isError, true);
  const details: { kind: "validation"; tool: string; validationErrors: Array<{ field: string }> } = fromAny(
    result.details,
  );
  assert.equal(details.kind, "validation");
  assert.equal(details.tool, "echo_test");
  assert.ok(Array.isArray(details.validationErrors));
  assert.equal(details.validationErrors[0].field, "text");
});

test("registered pi tool (opt-in throw mode): invalid args throw without calling the handler", async () => {
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

  registerPiTools(fromPartial(pi), [echoTool], { errorHandling: "throw" });
  const tool = registered.find((candidate) => candidate.name === "echo_test");
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute("tool-call-invalid", { text: 42 }, undefined, undefined, {}),
    (error: unknown) => {
      assert.equal(called, false);
      assert.ok(error instanceof PortableToolExecutionError);
      if (!isPortableToolExecutionError(error)) return false;
      assert.equal(error.details.kind, "validation");
      if (error.details.kind !== "validation") return false;
      assert.equal(error.details.tool, "echo_test");
      assert.ok(Array.isArray(error.details.validationErrors));
      assert.equal(error.details.validationErrors[0].field, "text");
      return true;
    },
  );
});
