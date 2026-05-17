import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";
import {
  definePortableTool,
  executePortableTool,
  type PortableToolBuiltInHost,
  type PortableToolContext,
  type PortableToolHost,
} from "@feniix/pi-portable-tools";

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

test("default portable tool context keeps the built-in host union", async () => {
  const observedHosts: PortableToolBuiltInHost[] = [];
  const echoTool = definePortableTool({
    name: "host_union_test",
    title: "Host Union Test",
    description: "Verifies default host typing.",
    parameters: echoParams,
    execute(args, ctx) {
      const builtInHost: PortableToolBuiltInHost = ctx.host;
      const exactHost: "pi" | "mcp" | "test" = ctx.host;
      observedHosts.push(builtInHost, exactHost);
      return { text: args.text };
    },
  });

  const defaultContext: PortableToolContext = { host: "pi" };
  const defaultHost: PortableToolHost = defaultContext.host;
  assert.equal(defaultHost, "pi");

  function rejectInvalidDefaultHosts() {
    // @ts-expect-error Custom hosts require an explicit PortableTool host generic.
    void executePortableTool(echoTool, { text: "hello" }, { host: "custom-adapter" });
  }
  void rejectInvalidDefaultHosts;

  const result = await executePortableTool(echoTool, { text: "hello" }, { host: "mcp" });

  assert.equal(result.text, "hello");
  assert.deepEqual(observedHosts, ["mcp", "mcp"]);
});

test("executePortableTool supports opt-in custom host identifiers", async () => {
  type CustomHost = PortableToolHost<"custom-adapter">;
  const observedHosts: CustomHost[] = [];
  const customTool = definePortableTool<typeof echoParams, "custom-adapter">({
    name: "custom_host_test",
    title: "Custom Host Test",
    description: "Verifies custom host typing.",
    parameters: echoParams,
    execute(args, ctx) {
      const customHost: "custom-adapter" = ctx.host;
      observedHosts.push(customHost);
      return { text: `${ctx.host}:${args.text}` };
    },
  });

  function rejectInvalidCustomHosts() {
    // @ts-expect-error Custom-only tools must execute with their declared host.
    void executePortableTool(customTool, { text: "hello" }, { host: "pi" });
  }
  void rejectInvalidCustomHosts;

  const result = await executePortableTool(customTool, { text: "hello" }, { host: "custom-adapter" });

  assert.equal(result.text, "custom-adapter:hello");
  assert.deepEqual(observedHosts, ["custom-adapter"]);
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
