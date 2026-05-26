import assert from "node:assert/strict";
import test from "node:test";
import {
  definePortableTool,
  executePortableTool,
  type PortableTool,
  type PortableToolBuiltInHost,
  type PortableToolContext,
  type PortableToolHost,
  type PortableValidationError,
} from "@feniix/bridgekit";
import { fromAny } from "@total-typescript/shoehorn";
import { type Static, Type } from "typebox";

function getValidationErrors(result: {
  structuredContent?: { validationErrors?: unknown } | undefined;
}): PortableValidationError[] {
  return fromAny(result.structuredContent?.validationErrors);
}

// Canonical discriminated-union shape used across several tests below.
// Branch A: { op: "create", name: string }; Branch B: { op: "delete", id: string }.
const opUnionParams = Type.Union([
  Type.Object({ op: Type.Literal("create"), name: Type.String() }),
  Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
]);

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
  const errors = getValidationErrors(result);
  assert.ok(Array.isArray(errors));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "text");
  assert.equal(typeof errors[0].message, "string");
  assert.ok(errors[0].message.length > 0);
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
  const errors = getValidationErrors(result);
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
  const errors = getValidationErrors(result);
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
  const errors = getValidationErrors(result);
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
  const errors = getValidationErrors(result);
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
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "count");
});

test("validatePortableToolArgs: union / discriminator mismatch dedupes by (field, message)", async () => {
  // TypeBox emits multiple raw errors on /kind for a union mismatch (one per
  // failed branch plus an anyOf wrapper). The exact count is TypeBox-internal
  // and may shift across patch releases. The behavioral contract is "no
  // duplicate (field, message) pairs survive dedup" — assert that directly.
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
  const errors = getValidationErrors(result);
  assert.ok(errors.length >= 1);
  for (const error of errors) {
    assert.equal(error.field, "kind");
  }
  // No duplicate (field, message) pairs survive dedup.
  const pairs = new Set(errors.map((e) => JSON.stringify([e.field, e.message])));
  assert.equal(pairs.size, errors.length);
});

test("validatePortableToolArgs: union of objects collapses sibling required errors under the anyOf summary", async () => {
  // Repro for #35: a union of two object branches with disjoint required
  // props, against `{}`, previously surfaced both "a" and "b" as missing —
  // misleading because the consumer only needs to satisfy ONE branch. The
  // `anyOf` summary at the same path is the correct signal; sibling
  // `required` entries are suppressed.
  //
  // The earlier `union_mismatch` test (Object-wrapping-union, `{ kind: "c" }`)
  // is intentionally unchanged by this rule: its sibling errors at `/kind`
  // are `const`, which are NOT in the suppression set — they carry real
  // discriminator info about which branch was intended.
  const tool = definePortableTool({
    name: "union_of_objects",
    title: "Union Of Objects",
    description: "Union of two object branches with disjoint required props.",
    parameters: Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })]),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "(root)");
  assert.match(errors[0].message, /anyOf/);
});

test("validatePortableToolArgs: discriminated union surfaces only the active branch's missing required prop", async () => {
  // Issue #38: when an `anyOf`/`oneOf` fires at a path and exactly one branch's
  // discriminator (`Literal`/`const`) is satisfied by the input, surface ONLY
  // that branch's `required` errors. The other branches' phantoms are still
  // suppressed.
  const tool = definePortableTool({
    name: "discriminated_union",
    title: "Discriminated Union",
    description: "Union of two object branches with a `op` literal discriminator.",
    parameters: opUnionParams,
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { op: "create" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
  assert.match(errors[0].message, /required property name/);
});

test("validatePortableToolArgs: discriminated union with invalid discriminator falls back to suppress-all", async () => {
  // Zero branches match — no actionable "you picked X, forgot Y" hint is
  // possible. Behavior falls back to PR #37: anyOf summary survives, per-branch
  // `required` phantoms are suppressed. The user fixes the discriminator first.
  const tool = definePortableTool({
    name: "discriminated_union_invalid",
    title: "Discriminated Union Invalid",
    description: "Union with invalid discriminator value.",
    parameters: opUnionParams,
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { op: "unknown" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  // No per-branch `required` phantoms survive — they have no actionable owner.
  for (const error of errors) {
    assert.notEqual(error.field, "name");
    assert.notEqual(error.field, "id");
  }
  // Both the anyOf summary at (root) and the const errors at /op must remain
  // — the latter now carry the allowed values in `message` so the user (or
  // agent) can see exactly which discriminator values would be accepted.
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes("(root)"), "anyOf summary must survive fallback");
  assert.ok(fields.includes("op"), "const errors at /op must survive fallback");
  const opErrors = errors.filter((e) => e.field === "op");
  const opMessages = opErrors.map((e) => e.message).sort();
  assert.deepEqual(opMessages, ['must equal "create"', 'must equal "delete"']);
});

test("validatePortableToolArgs: nested discriminated union surfaces active branch's missing prop at the right path", async () => {
  // Same algorithm, but the Union is wrapped in an Object property. The union
  // path is "/event"; the active branch should still drive sibling preservation.
  const tool = definePortableTool({
    name: "nested_discriminated_union",
    title: "Nested Discriminated Union",
    description: "Object wrapping a discriminated union.",
    parameters: Type.Object({ event: opUnionParams }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { event: { op: "create" } }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
  assert.match(errors[0].message, /required property name/);
});

test("validatePortableToolArgs: enum-discriminator resolves the active branch", async () => {
  // `Type.String({ enum: [...] })` discriminator (multi-value tag) — exercises
  // the enum branch of readDiscriminatorValues.
  const tool = definePortableTool({
    name: "enum_discriminator",
    title: "Enum Discriminator",
    description: "Discriminator is a string enum, not a Literal.",
    parameters: Type.Union([
      Type.Object({ op: Type.String({ enum: ["create", "update"] }), name: Type.String() }),
      Type.Object({ op: Type.String({ enum: ["delete"] }), id: Type.String() }),
    ]),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { op: "create" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validatePortableToolArgs: Union-of-Literals discriminator (anyOf-of-const) resolves the active branch", async () => {
  // Idiomatic `Type.Union([Type.Literal("a"), Type.Literal("b")])` for the
  // discriminator. TypeBox renders this as `{ anyOf: [{const:"a"}, {const:"b"}] }`.
  const tool = definePortableTool({
    name: "anyof_of_const_discriminator",
    title: "anyOf-of-const Discriminator",
    description: "Discriminator is a Union of Literals.",
    parameters: Type.Union([
      Type.Object({
        op: Type.Union([Type.Literal("create"), Type.Literal("update")]),
        name: Type.String(),
      }),
      Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
    ]),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { op: "update" }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validatePortableToolArgs: array of discriminated unions resolves per element", async () => {
  // Most common real-world shape for discriminated unions in tool inputs:
  // a batch of operations/events. The path walker must descend through `items`
  // for numeric path segments.
  const tool = definePortableTool({
    name: "array_of_unions",
    title: "Array of Discriminated Unions",
    description: "Array of operations, each a discriminated union.",
    parameters: Type.Object({ events: Type.Array(opUnionParams) }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { events: [{ op: "create" }] }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "name");
});

test("validatePortableToolArgs: discriminator key on Object.prototype does not falsely match", async () => {
  // Defensive against prototype-chain pollution: a schema discriminator named
  // `toString` against an input that lacks it must NOT match via the prototype.
  // The matcher uses Object.hasOwn to keep this clean.
  const tool = definePortableTool({
    name: "prototype_discriminator",
    title: "Prototype Discriminator",
    description: "Discriminator prop name collides with Object prototype.",
    parameters: Type.Union([
      Type.Object({ toString: Type.Literal("create"), name: Type.String() }),
      Type.Object({ toString: Type.Literal("delete"), id: Type.String() }),
    ]),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  // Neither branch's discriminator should match an inherited toString. The
  // resolution falls back to suppress-all (no-active), so the anyOf summary
  // survives but the per-branch `required` phantoms are dropped.
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  for (const error of errors) {
    assert.notEqual(error.field, "name", "branch A's required phantom must not survive");
    assert.notEqual(error.field, "id", "branch B's required phantom must not survive");
  }
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
  const errors = getValidationErrors(result);
  assert.deepEqual(errors.map((e) => e.field).sort(), ["count", "file_path"]);
  for (const error of errors) {
    assert.match(error.message, /required property/);
  }
});

test("validatePortableToolArgs: slash in property name survives intact for wrong-type errors (schema-walk fallback)", async () => {
  // TypeBox does NOT escape `/` in property names when building `instancePath`
  // (it doesn't follow JSON Pointer RFC 6901's `~1` encoding). A property
  // named `a/b` produces `instancePath: "/a/b"` on a wrong-type error. The
  // string-split fallback would yield `field: "b"`; the schema-walk fallback
  // recognizes that `a/b` is a single property key on the parent schema and
  // surfaces it intact. Required/additionalProperties keywords are unaffected
  // (they read structured `params`); this test covers the non-required
  // keyword paths. Resolves #36.
  const tool = definePortableTool({
    name: "slash_prop",
    title: "Slash Prop",
    description: "Schema with a slash in its property name.",
    parameters: Type.Object({ "a/b": Type.String() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { "a/b": 42 }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "a/b");
  assert.match(errors[0].message, /must be string/);
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
  const errors = getValidationErrors(result);
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
  const errors = getValidationErrors(result);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, "(root)");
  assert.match(errors[0].message, /must be object/);
  // The text formatter prefixes the (root) sentinel without producing a
  // double-colon. Match structurally to stay resilient to TypeBox locale
  // changes that might rephrase "must be object".
  assert.match(result.text, /^Invalid arguments for object_schema_null_args: \(root\): /);
});

test("validatePortableToolArgs: additionalProperties=false surfaces the offending key as field", async () => {
  const tool = definePortableTool({
    name: "no_additional",
    title: "No Additional",
    description: "Schema rejects additional properties.",
    parameters: Type.Object({ x: Type.String() }, { additionalProperties: false }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, { x: "ok", extra: 1 }, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.deepEqual(
    errors.map((e) => e.field),
    ["extra"],
  );
  assert.match(errors[0].message, /must not have additional property extra/);
});

test("validatePortableToolArgs: empty-string property name falls back to (root) sentinel", async () => {
  // params.requiredProperties is filtered for length > 0, so a missing
  // pathological-named "" prop falls back to the instancePath-based path,
  // which produces (root) for empty instancePath. field is never "".
  const tool = definePortableTool({
    name: "empty_string_prop",
    title: "Empty String Prop",
    description: "Schema with an empty-string property name.",
    parameters: Type.Object({ "": Type.String() }),
    execute() {
      return { text: "ok" };
    },
  });
  const result = await executePortableTool(tool, {}, { host: "test" });
  assert.equal(result.isError, true);
  const errors = getValidationErrors(result);
  assert.ok(errors.length >= 1);
  for (const error of errors) {
    assert.notEqual(error.field, "");
  }
});
