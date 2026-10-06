import assert from "node:assert/strict";
import test from "node:test";
import { definePortableTool, executePortableTool, type PortableToolResult } from "@feniix/bridgekit";
import { fromAny } from "@total-typescript/shoehorn";
import { Type } from "typebox";

test("portable execution validates successful structured output without widening its inferred type", async () => {
  const tool = definePortableTool({
    name: "typed_output",
    title: "Typed output",
    description: "Returns schema-declared data.",
    parameters: Type.Object({}),
    outputSchema: Type.Object({ count: Type.Number() }),
    execute: () => ({ text: "one", structuredContent: { count: 1 } }),
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.deepEqual(result, { text: "one", structuredContent: { count: 1 } });
  if (result.isError !== true) {
    const count: number = result.structuredContent.count;
    assert.equal(count, 1);
  }
});

test("portable output schemas must be inlined object schemas or intersections of objects", async () => {
  for (const outputSchema of [Type.String(), Type.Union([Type.Object({}), Type.Object({})])]) {
    const tool = definePortableTool({
      name: "bad_output_schema",
      title: "Bad schema",
      description: "Non-object output schema",
      parameters: Type.Object({}),
      outputSchema,
      execute: () => ({ text: "no data", structuredContent: {} }),
    });
    await assert.rejects(executePortableTool(tool, {}, { host: "test" }), /bad_output_schema.*object/);
  }
});

test("success-only output schemas exempt argument and domain failures", async () => {
  const tool = definePortableTool({
    name: "error_output",
    title: "Error output",
    description: "Returns domain data outside the success schema.",
    parameters: Type.Object({ count: Type.Number() }),
    outputSchema: Type.Object({ count: Type.Number() }),
    execute: () => ({ text: "unavailable", structuredContent: { reason: "offline" }, isError: true }),
  });
  const domain = await executePortableTool(tool, { count: 1 }, { host: "test" });
  assert.deepEqual(domain, { text: "unavailable", structuredContent: { reason: "offline" }, isError: true });
  const invalid = await executePortableTool(tool, { count: "one" }, { host: "test" });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /Invalid arguments for error_output/);
});

test("invalid or missing successful structured output throws instead of being advertised as success", async () => {
  for (const result of [
    { text: "wrong", structuredContent: { count: "one" } },
    { text: "missing" },
    { text: "legacy is not declared output", details: { count: 1 } },
  ]) {
    // Deliberately inject untyped runtime data to exercise the runtime guard.
    const execute: () => { text: string; structuredContent: { count: number } } = fromAny(() => result);
    const tool = definePortableTool({
      name: "invalid_output",
      title: "Invalid output",
      description: "Violates its output contract.",
      parameters: Type.Object({}),
      outputSchema: Type.Object({ count: Type.Number() }),
      execute,
    });
    await assert.rejects(executePortableTool(tool, {}, { host: "test" }), {
      name: "TypeError",
      message: /Invalid structured output for invalid_output/,
    });
  }
});

test("an optional object output schema still requires successful structuredContent", async () => {
  const execute: () => { text: string; structuredContent: Record<string, unknown> } = fromAny(() => ({
    text: "missing",
  }));
  const tool = definePortableTool({
    name: "optional_output",
    title: "Optional output",
    description: "Must supply structured output even if the schema accepts undefined.",
    parameters: Type.Object({}),
    outputSchema: Type.Optional(Type.Object({})),
    execute,
  });
  await assert.rejects(
    executePortableTool(tool, {}, { host: "test" }),
    /Invalid structured output for optional_output/,
  );
});

test("object intersections can describe portable output", async () => {
  const tool = definePortableTool({
    name: "intersect_output",
    title: "Intersect output",
    description: "Composed object output",
    parameters: Type.Object({}),
    outputSchema: Type.Intersect([Type.Object({ name: Type.String() }), Type.Object({ count: Type.Number() })]),
    execute: () => ({ text: "one", structuredContent: { name: "one", count: 1 } }),
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.deepEqual(result.structuredContent, { name: "one", count: 1 });
});

test("explicit legacy function generics erase schema typing but retain runtime output validation", async () => {
  const parameters = Type.Object({});
  const tool = definePortableTool<typeof parameters, PortableToolResult>({
    name: "erased_output",
    title: "Erased output",
    description: "Legacy explicit generics opt out of schema inference.",
    parameters,
    outputSchema: Type.Object({ count: Type.Number() }),
    execute: () => ({ text: "wrong", structuredContent: { count: "one" } }),
  });
  await assert.rejects(executePortableTool(tool, {}, { host: "test" }), {
    name: "TypeError",
    message: /Invalid structured output for erased_output/,
  });
});
