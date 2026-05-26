import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, type PortableToolHostExtras } from "@feniix/bridgekit";
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

// --- hostExtras.pi.pendingMessage (issue #28, RFC §3 Gap B) ---

test("registered pi tool without hostExtras emits zero updates before the handler runs (Test A)", async () => {
  // Zero-cost-when-absent invariant: a tool without `hostExtras` must not
  // produce any pre-execute onUpdate. The handler emits progress updates,
  // but they all originate from inside execute() — never before it.
  let handlerEntered = false;
  const handlerEmittedAt: number[] = [];
  const observedUpdateOrder: number[] = [];
  const echoTool = definePortableTool({
    name: "no_extras",
    title: "No Extras",
    description: "Tool without hostExtras; no pre-execute update expected.",
    parameters: echoParams,
    execute(args, ctx) {
      handlerEntered = true;
      handlerEmittedAt.push(observedUpdateOrder.length);
      ctx.progress?.({ text: "starting", structuredContent: { phase: "start" } });
      return { text: args.text };
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [echoTool]);
  const tool = registered.find((candidate) => candidate.name === "no_extras");
  assert.ok(tool);

  let updateCount = 0;
  await tool.execute(
    "tool-call-no-extras",
    { text: "hello" },
    undefined,
    () => {
      observedUpdateOrder.push(updateCount);
      updateCount += 1;
    },
    {},
  );

  // The handler entered before any update was observed, so the first update
  // index (if any) is at-or-after handler entry. The handler's own progress
  // call is the only update — there is no pre-execute one.
  assert.equal(handlerEntered, true);
  assert.equal(updateCount, 1, "exactly one update — from the handler's progress call");
  assert.equal(handlerEmittedAt[0], 0, "handler ran before any update reached onUpdate");
});

test("registered pi tool fires hostExtras.pi.pendingMessage exactly once before the handler runs (Test C)", async () => {
  let handlerEntered = false;
  let updateCountBeforeHandler = 0;
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> = [];
  const pendingTool = definePortableTool({
    name: "pending_msg",
    title: "Pending Msg",
    description: "Tool with hostExtras.pi.pendingMessage.",
    parameters: echoParams,
    execute(args) {
      // The pre-execute onUpdate must have already fired by the time the
      // handler runs.
      updateCountBeforeHandler = updates.length;
      handlerEntered = true;
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "Processing..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_msg");
  assert.ok(tool);

  await tool.execute(
    "tool-call-pending",
    { text: "hello" },
    undefined,
    (update: unknown) =>
      updates.push(update as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }),
    {},
  );

  assert.equal(handlerEntered, true);
  assert.equal(updateCountBeforeHandler, 1, "pre-execute onUpdate fired before the handler ran");
  assert.deepEqual(updates[0], {
    content: [{ type: "text", text: "Processing..." }],
    details: { status: "pending" },
  });
});

test("registered pi tool fires hostExtras.pi.pendingMessage at-most-once per invocation (Test D)", async () => {
  const pendingTool = definePortableTool({
    name: "pending_once",
    title: "Pending Once",
    description: "Pre-execute message must not accumulate across sequential calls.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "Working..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_once");
  assert.ok(tool);

  const firstUpdates: unknown[] = [];
  await tool.execute("call-1", { text: "a" }, undefined, (update: unknown) => firstUpdates.push(update), {});
  assert.equal(firstUpdates.length, 1, "first invocation: exactly one pre-execute onUpdate");
  assert.deepEqual(firstUpdates[0], {
    content: [{ type: "text", text: "Working..." }],
    details: { status: "pending" },
  });

  const secondUpdates: unknown[] = [];
  await tool.execute("call-2", { text: "b" }, undefined, (update: unknown) => secondUpdates.push(update), {});
  assert.equal(secondUpdates.length, 1, "second invocation: exactly one pre-execute onUpdate (not zero, not two)");
  assert.deepEqual(secondUpdates[0], {
    content: [{ type: "text", text: "Working..." }],
    details: { status: "pending" },
  });
});

// RFC §9 #3 [GATING] — pendingMessage fires before validation.
//
// The existing "before handler" test (Test C above) supplies args that
// satisfy TypeBox validation, so it cannot distinguish "before handler" from
// "before validation". This test uses args that FAIL validation and asserts
// the pre-execute emit still fires before the validation-failure result is
// returned and the handler is not invoked.
test("hostExtras.pi.pendingMessage fires before TypeBox validation runs (RFC §9 #3)", async () => {
  let handlerInvoked = false;
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> = [];
  const pendingTool = definePortableTool({
    name: "pending_before_validation",
    title: "Pending Before Validation",
    description: "Pre-execute emit must fire even when args fail validation.",
    parameters: echoParams,
    execute() {
      handlerInvoked = true;
      throw new Error("handler should not run on validation failure");
    },
    hostExtras: {
      pi: { pendingMessage: "Processing..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_before_validation");
  assert.ok(tool);

  // `text: 42` violates `text: Type.String()`. Validation rejects before the
  // handler runs.
  const result = await tool.execute(
    "call",
    { text: 42 },
    undefined,
    (update: unknown) =>
      updates.push(update as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }),
    {},
  );

  assert.equal(handlerInvoked, false, "handler must not run on validation failure");
  assert.equal(result.isError, true, "validation failure surfaces as isError result");
  assert.equal(updates.length, 1, "pre-execute emit fires exactly once, before validation");
  assert.deepEqual(updates[0], {
    content: [{ type: "text", text: "Processing..." }],
    details: { status: "pending" },
  });
});

test("pre-execute onUpdate throw routes through errorHandling: return as isError result", async () => {
  // Contract: a throwing host `onUpdate` at the pre-execute emit site is
  // routed through the same catch as a handler-thrown exception. In return
  // mode, the result is `{ isError: true, ... }` with the thrown message
  // preserved as the text content. The handler is NOT invoked, because the
  // pre-execute emit fires before the handler. Pins the fix for the issue
  // where the pre-execute emit sat outside the surrounding try/catch and
  // bypassed `errorHandling: "return"`.
  let handlerEntered = false;
  const pendingTool = definePortableTool({
    name: "pending_throwing_onupdate",
    title: "Pending Throwing onUpdate",
    description: "Pre-execute emit must route a throwing onUpdate through errorHandling.",
    parameters: echoParams,
    execute(args) {
      handlerEntered = true;
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "Processing..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_throwing_onupdate");
  assert.ok(tool);

  const result = await tool.execute(
    "call",
    { text: "x" },
    undefined,
    () => {
      throw new Error("host onUpdate failed");
    },
    {},
  );

  assert.equal(handlerEntered, false, "pre-execute emit's throw must short-circuit before the handler");
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: "text", text: "host onUpdate failed" }]);
  assert.deepEqual(result.details, {});
});

test("pre-execute onUpdate throw routes through errorHandling: throw as exception", async () => {
  // Symmetric test for opt-in throw mode: the thrown error propagates up
  // the call stack unchanged. The handler is still not invoked.
  let handlerEntered = false;
  const pendingTool = definePortableTool({
    name: "pending_throwing_onupdate_throw_mode",
    title: "Pending Throwing onUpdate (throw mode)",
    description: "Same as the return-mode test, but errorHandling: 'throw'.",
    parameters: echoParams,
    execute(args) {
      handlerEntered = true;
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "Processing..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool], { errorHandling: "throw" });
  const tool = registered.find((candidate) => candidate.name === "pending_throwing_onupdate_throw_mode");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "call",
        { text: "x" },
        undefined,
        () => {
          throw new Error("host onUpdate failed");
        },
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "host onUpdate failed");
      assert.equal(handlerEntered, false, "pre-execute emit's throw must short-circuit before the handler");
      return true;
    },
  );
});

test("registered pi tool with hostExtras.pi.pendingMessage no-ops when onUpdate is undefined", async () => {
  // RFC §2: when the host does not provide onUpdate, the adapter silently
  // no-ops — no throw, no stored emit. Pinned so a future refactor that
  // queues updates internally cannot regress the contract.
  let handlerEntered = false;
  const pendingTool = definePortableTool({
    name: "pending_no_onupdate",
    title: "Pending No onUpdate",
    description: "hostExtras.pi.pendingMessage with no onUpdate provided.",
    parameters: echoParams,
    execute(args) {
      handlerEntered = true;
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "Should not throw." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_no_onupdate");
  assert.ok(tool);

  // No onUpdate (undefined). The adapter must run the handler without throwing.
  const result = await tool.execute("call", { text: "x" }, undefined, undefined, {});
  assert.equal(handlerEntered, true);
  assert.equal(result.isError, false);
});

test("registerPiTools passes hostExtras.pi.promptSnippet / promptGuidelines through to pi.registerTool (Test E)", () => {
  const guidelines = ["Use sparingly.", "Always validate the input."] as const;
  const richTool = definePortableTool({
    name: "rich_tool",
    title: "Rich Tool",
    description: "Tool with prompt metadata.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: {
      pi: {
        promptSnippet: "Call this tool when the user asks to echo text.",
        promptGuidelines: guidelines,
      },
    },
  });
  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [richTool]);

  assert.equal(registered.length, 1);
  const registration = registered[0];
  assert.equal(registration?.promptSnippet, "Call this tool when the user asks to echo text.");
  assert.equal(registration?.promptGuidelines, guidelines, "guidelines forwarded by reference (immutable contract)");
});

test("registerPiTools omits unset pi pass-through fields (byte-identical shape when hostExtras is absent)", () => {
  // Zero-cost-when-absent: a tool without hostExtras must produce a
  // registration whose own-property keys exactly match the pre-0.9 set
  // {name, label, description, parameters, execute}. Pinned so a future
  // refactor that unconditionally spreads pi-extras keys is caught.
  const plainTool = definePortableTool({
    name: "plain",
    title: "Plain",
    description: "No hostExtras.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
  });
  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [plainTool]);

  assert.deepEqual(Object.keys(registered[0] ?? {}).sort(), ["description", "execute", "label", "name", "parameters"]);
});

test("registerPiTools omits unset pass-through fields when only some hostExtras.pi keys are set", () => {
  // Mixed case: only promptSnippet is set. promptGuidelines must not appear
  // as an `undefined` key on the registration object.
  const partialTool = definePortableTool({
    name: "partial",
    title: "Partial",
    description: "Only promptSnippet is set.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: {
      pi: { promptSnippet: "snippet" },
    },
  });
  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [partialTool]);

  const keys = Object.keys(registered[0] ?? {}).sort();
  assert.deepEqual(keys, ["description", "execute", "label", "name", "parameters", "promptSnippet"]);
});

test("registered pi tool does not emit pre-execute update when pendingMessage is an empty string", async () => {
  // RFC §3: "Must not fire when hostExtras.pi.pendingMessage is unset or
  // empty string." Empty-string is a valid declarative no-op (cleaner than
  // a conditional spread at the call site); pin the behavior so a refactor
  // that drops the empty-string guard surfaces here.
  const pendingTool = definePortableTool({
    name: "pending_empty",
    title: "Pending Empty",
    description: "hostExtras.pi.pendingMessage = empty string.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: {
      pi: { pendingMessage: "" },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool]);
  const tool = registered.find((candidate) => candidate.name === "pending_empty");
  assert.ok(tool);

  const updates: unknown[] = [];
  await tool.execute("call", { text: "x" }, undefined, (update: unknown) => updates.push(update), {});
  assert.equal(updates.length, 0, "empty-string pendingMessage produces no update");
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

// RFC §9 #2 [GATING] — Zero-cost shape: hostExtras: {} (empty object).
//
// Two tools that differ only in whether `hostExtras` is absent vs. `{}` must
// produce observationally identical registrations: the same own-property
// key set on `pi.registerTool(...)` and no pre-execute onUpdate emitted.
test("hostExtras: {} produces byte-identical pi registration to absent hostExtras (RFC §9 #2 GATING)", async () => {
  const toolAbsent = definePortableTool({
    name: "absent_extras",
    title: "Absent Extras",
    description: "Tool without hostExtras.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
  });
  const toolEmpty = definePortableTool({
    name: "empty_extras",
    title: "Empty Extras",
    description: "Tool with hostExtras: {}.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: {},
  });

  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [toolAbsent, toolEmpty]);
  assert.equal(registered.length, 2);

  const keysAbsent = Object.keys(registered[0] ?? {}).sort();
  const keysEmpty = Object.keys(registered[1] ?? {}).sort();
  assert.deepEqual(keysAbsent, keysEmpty, "registration key sets must match");
  assert.deepEqual(keysAbsent, ["description", "execute", "label", "name", "parameters"]);

  // Neither tool emits a pre-execute onUpdate.
  const absentUpdates: unknown[] = [];
  const emptyUpdates: unknown[] = [];
  const absent = registered[0] as unknown as RegisteredPiTool;
  const empty = registered[1] as unknown as RegisteredPiTool;
  await absent.execute("call-absent", { text: "x" }, undefined, (u: unknown) => absentUpdates.push(u), {});
  await empty.execute("call-empty", { text: "x" }, undefined, (u: unknown) => emptyUpdates.push(u), {});
  assert.equal(absentUpdates.length, 0);
  assert.equal(emptyUpdates.length, 0);
});

// RFC §9 #5 — pendingMessage × errorHandling: "throw" ordering.
//
// In throw mode, validation failure raises PortableToolExecutionError. The
// pre-execute emit must reach the channel before the throw — it sits above
// validation in the lifecycle, and the catch block re-raises, it doesn't
// swallow the emit.
test("pendingMessage fires before PortableToolExecutionError in errorHandling: 'throw' mode (RFC §9 #5)", async () => {
  const updates: Array<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> = [];
  const pendingTool = definePortableTool({
    name: "pending_throw_mode",
    title: "Pending Throw Mode",
    description: "Pre-execute emit fires once before the throw in throw mode.",
    parameters: echoParams,
    execute() {
      throw new Error("handler should not run on validation failure");
    },
    hostExtras: {
      pi: { pendingMessage: "Processing..." },
    },
  });
  const registered: RegisteredPiTool[] = [];
  const pi = {
    registerTool(tool: RegisteredPiTool) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [pendingTool], { errorHandling: "throw" });
  const tool = registered.find((candidate) => candidate.name === "pending_throw_mode");
  assert.ok(tool);

  await assert.rejects(
    () =>
      tool.execute(
        "call",
        { text: 42 },
        undefined,
        (update: unknown) =>
          updates.push(update as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }),
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof PortableToolExecutionError);
      return true;
    },
  );

  assert.equal(updates.length, 1, "pre-execute emit fired once before the throw");
  assert.deepEqual(updates[0], {
    content: [{ type: "text", text: "Processing..." }],
    details: { status: "pending" },
  });
});

// RFC §9 #8 — Unknown-host keys runtime ignored.
//
// A tool carrying `hostExtras["custom-runtime"]` (without a module
// augmentation in scope, so the type slot doesn't exist for the test) must
// produce a pi registration whose key set is unchanged: pi does not look
// at namespaces it doesn't recognise, no leak of custom-runtime keys, no
// throw.
test("registerPiTools ignores unknown host namespaces at runtime (RFC §9 #8)", async () => {
  const sneakyExtras = { "custom-runtime": { foo: "bar" } } as unknown as PortableToolHostExtras;
  const sneakyTool = definePortableTool({
    name: "sneaky_extras",
    title: "Sneaky Extras",
    description: "Tool with an unknown-host namespace; pi must ignore it.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
    hostExtras: sneakyExtras,
  });

  const registered: Array<Record<string, unknown>> = [];
  const pi = {
    registerTool(tool: Record<string, unknown>) {
      registered.push(tool);
    },
  };

  registerPiTools(fromPartial(pi), [sneakyTool]);
  assert.equal(registered.length, 1);
  const keys = Object.keys(registered[0] ?? {}).sort();
  assert.deepEqual(
    keys,
    ["description", "execute", "label", "name", "parameters"],
    "no leak of unknown-host namespace keys onto the pi registration",
  );

  // Invocation succeeds — the unknown namespace is ignored, not surfaced.
  const tool = registered[0] as unknown as RegisteredPiTool;
  const result = await tool.execute("call", { text: "x" }, undefined, undefined, {});
  assert.equal(result.isError, false);
});
