import assert from "node:assert/strict";
import test from "node:test";
import {
  definePortableTool,
  executePortableTool,
  type PortableTool,
  type PortableToolBuiltInHost,
  type PortableToolContext,
  type PortableToolHost,
} from "@feniix/bridgekit";
import { type Static, Type } from "typebox";

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

  function rejectBuiltInOnlyToolInCustomCollections() {
    // @ts-expect-error Built-in-only tools cannot be treated as custom-host capable.
    const customHostTools: Array<PortableTool<typeof echoParams, PortableToolHost<"custom-adapter">>> = [echoTool];
    void customHostTools;
  }
  void rejectBuiltInOnlyToolInCustomCollections;

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
  assert.equal(result.structuredContent?.kind, "validation");
  assert.equal(result.structuredContent?.tool, "echo_test");
  const validationErrors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.ok(Array.isArray(validationErrors));
  assert.equal(validationErrors.length, 1);
  assert.equal(validationErrors[0].field, "text");
  assert.equal(typeof validationErrors[0].message, "string");
  assert.ok(validationErrors[0].message.length > 0);
});

test("validatePortableToolArgs: missing top-level required property", async () => {
  const tool = definePortableTool({
    name: "missing_required",
    title: "Missing Required",
    description: "Schema requires file_path.",
    parameters: Type.Object({ file_path: Type.String() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.deepEqual(
    errors.map((e) => e.field),
    ["file_path"],
  );
  assert.match(errors[0].message, /required property file_path/);
});

test("validatePortableToolArgs: wrong type on top-level property", async () => {
  const tool = definePortableTool({
    name: "wrong_type_top",
    title: "Wrong Type Top",
    description: "count must be number.",
    parameters: Type.Object({ count: Type.Number() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { count: "x" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "count");
});

test("validatePortableToolArgs: wrong type on nested property", async () => {
  const tool = definePortableTool({
    name: "wrong_type_nested",
    title: "Wrong Type Nested",
    description: "inner.name must be string.",
    parameters: Type.Object({ inner: Type.Object({ name: Type.String() }) }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { inner: { name: 42 } }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validatePortableToolArgs: nested required property missing surfaces the missing prop name", async () => {
  // /inner has instancePath="/inner", but the missing prop is "name" (the
  // child). The structured-access path reads params.requiredProperties and
  // surfaces "name" rather than the parent segment.
  const tool = definePortableTool({
    name: "nested_required_missing",
    title: "Nested Required Missing",
    description: "Schema requires inner.name.",
    parameters: Type.Object({ inner: Type.Object({ name: Type.String() }) }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { inner: {} }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.deepEqual(
    errors.map((e) => e.field),
    ["name"],
  );
  assert.match(errors[0].message, /required property name/);
});

test("validatePortableToolArgs: out-of-range integer", async () => {
  const tool = definePortableTool({
    name: "out_of_range",
    title: "Out Of Range",
    description: "count must be >= 0.",
    parameters: Type.Object({ count: Type.Number({ minimum: 0 }) }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { count: -1 }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "count");
});

test("validatePortableToolArgs: union / discriminator mismatch dedupes by (field, message)", async () => {
  // TypeBox emits three raw errors on /kind: two `must be equal to constant`
  // (one per literal) plus a `must match a schema in anyOf`. The dedup
  // collapses the literal-constant pair into one, leaving 2 entries.
  const tool = definePortableTool({
    name: "union_mismatch",
    title: "Union Mismatch",
    description: "kind must be 'a' or 'b'.",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("a"), Type.Literal("b")]) }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { kind: "c" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.equal(errors.length, 2);
  for (const error of errors) {
    assert.equal(error.field, "kind");
  }
  // No duplicate (field, message) pairs survive dedup.
  const pairs = new Set(errors.map((e) => `${e.field}\x00${e.message}`));
  assert.equal(pairs.size, errors.length);
});

test("validatePortableToolArgs: multiple missing required properties expand to one error per field", async () => {
  const tool = definePortableTool({
    name: "multiple_missing_required",
    title: "Multiple Missing Required",
    description: "Schema requires file_path and count.",
    parameters: Type.Object({ file_path: Type.String(), count: Type.Number() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.deepEqual(errors.map((e) => e.field).sort(), ["count", "file_path"]);
  for (const error of errors) {
    assert.match(error.message, /required property/);
  }
});

test("validatePortableToolArgs: comma in property name survives intact (structured access, not message parsing)", async () => {
  // The previous regex-based approach would split "must have required
  // properties a,b" into ["a", "b"]. Structured access reads
  // params.requiredProperties which preserves the original prop name verbatim.
  const tool = definePortableTool({
    name: "comma_prop",
    title: "Comma Prop",
    description: "Schema with a comma in its property name.",
    parameters: Type.Object({ "a,b": Type.String() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.deepEqual(
    errors.map((e) => e.field),
    ["a,b"],
  );
});

test("validatePortableToolArgs: non-object args produce field=(root), not empty string", async () => {
  const tool = definePortableTool({
    name: "object_schema_null_args",
    title: "Object Schema Null Args",
    description: "Schema is Object; args is null.",
    parameters: Type.Object({ field: Type.String() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, null, { host: "test" });
  assert.equal(result.isError, true);
  const errors = result.structuredContent?.validationErrors as Array<{ field: string; message: string }>;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "(root)");
  assert.match(errors[0].message, /must be object/);
  // The text formatter must not produce a double-colon when prefixing with
  // the (root) sentinel.
  assert.equal(result.text, "Invalid arguments for object_schema_null_args: (root): must be object");
});
