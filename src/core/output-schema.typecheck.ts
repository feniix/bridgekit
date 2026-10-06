import { definePortableTool, executePortableTool, type PortableTool, type PortableToolResult } from "@feniix/bridgekit";
import { Type } from "typebox";

const parameters = Type.Object({ fail: Type.Boolean() });
const outputSchema = Type.Object({ count: Type.Number() });
const metadata = { name: "typed_output", title: "Typed output", description: "Schema-linked output", parameters };

const valid = definePortableTool({
  ...metadata,
  outputSchema,
  execute: (args) => {
    if (args.fail) return { text: "offline", isError: true, structuredContent: { reason: "offline" } };
    return { text: "one", structuredContent: { count: 1, extra: "retained" } };
  },
});

async function inferred(): Promise<void> {
  const result = await executePortableTool(valid, { fail: false }, { host: "test" });
  if (result.isError !== true) {
    const count: number = result.structuredContent.count;
    const extra: string = result.structuredContent.extra;
    // @ts-expect-error schema checking must not widen inferred count to unknown/string
    const wrong: string = result.structuredContent.count;
    void [count, extra, wrong];
  }
}
void inferred;

// @ts-expect-error successful output must match the schema; it cannot widen the schema inference
definePortableTool({
  ...metadata,
  outputSchema,
  execute: () => ({ text: "wrong", structuredContent: { count: "one" } }),
});

// @ts-expect-error asynchronous successes must also match
definePortableTool({
  ...metadata,
  outputSchema,
  execute: async () => ({ text: "wrong", structuredContent: { count: "one" } }),
});

// @ts-expect-error successful structuredContent is required
definePortableTool({
  ...metadata,
  outputSchema,
  execute: () => ({ text: "missing" }),
});

// @ts-expect-error legacy details do not satisfy a declared success output
definePortableTool({
  ...metadata,
  outputSchema,
  execute: () => ({ text: "legacy", details: { count: 1 } }),
});

// @ts-expect-error an optional root still requires an object on successful results
definePortableTool({
  ...metadata,
  outputSchema: Type.Optional(Type.Object({})),
  execute: () => ({ text: "missing" }),
});

const direct: PortableTool<typeof parameters, PortableToolResult, typeof outputSchema> = {
  ...metadata,
  outputSchema,
  // @ts-expect-error explicit schema-typed PortableTool definitions also enforce output
  execute: () => ({ text: "wrong", structuredContent: { count: "one" } }),
};
void direct;

// Existing two-generic annotations erase schema specificity and stay compatible.
const erased: PortableTool<typeof parameters, PortableToolResult> = valid;
const legacy = definePortableTool<typeof parameters, PortableToolResult>({
  ...metadata,
  execute: () => ({ text: "details only", details: { count: 1 } }),
});
void [erased, legacy];

definePortableTool({
  ...metadata,
  outputSchema,
  execute: async () => ({ text: "offline", isError: true, structuredContent: { reason: "offline" } }),
});

definePortableTool({
  ...metadata,
  outputSchema,
  execute: () => ({ text: "offline", isError: true }),
});

// Non-object roots: arrays and primitives are checked without the open-record
// intersection object roots keep; unions of objects keep it per branch.
const arrayOutput = definePortableTool({
  ...metadata,
  outputSchema: Type.Array(Type.Number()),
  execute: () => ({ text: "list", structuredContent: [1, 2, 3] }),
});
const stringOutput = definePortableTool({
  ...metadata,
  outputSchema: Type.String(),
  execute: () => ({ text: "plain", structuredContent: "plain" }),
});
const unionOutput = definePortableTool({
  ...metadata,
  outputSchema: Type.Union([Type.Object({ ok: Type.Literal(true) }), Type.Object({ reason: Type.String() })]),
  execute: () => ({ text: "busy", structuredContent: { reason: "busy", extra: 1 } }),
});

async function nonObjectInferred(): Promise<void> {
  const list = await executePortableTool(arrayOutput, { fail: false }, { host: "test" });
  if (list.isError !== true) {
    const first: number | undefined = list.structuredContent[0];
    void first;
  }
  const plain = await executePortableTool(stringOutput, { fail: false }, { host: "test" });
  if (plain.isError !== true) {
    const value: string = plain.structuredContent;
    void value;
  }
  const union = await executePortableTool(unionOutput, { fail: false }, { host: "test" });
  if (union.isError !== true && "reason" in union.structuredContent) {
    const reason: string = union.structuredContent.reason;
    void reason;
  }
}
void nonObjectInferred;

// @ts-expect-error array roots check element types
definePortableTool({
  ...metadata,
  outputSchema: Type.Array(Type.Number()),
  execute: () => ({ text: "wrong", structuredContent: ["one"] }),
});

// @ts-expect-error primitive roots reject objects
definePortableTool({
  ...metadata,
  outputSchema: Type.String(),
  execute: () => ({ text: "wrong", structuredContent: { value: "plain" } }),
});

// Bare `PortableTool` accepts any result shape, so adapter tool lists do too.
const anyShape: PortableTool[] = [valid, arrayOutput, stringOutput, unionOutput];
void anyShape;
