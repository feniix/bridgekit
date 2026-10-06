import { definePortableTool, executePortableTool, type PortableTool, type PortableToolResult } from "@feniix/bridgekit";
import { type TSchema, Type } from "typebox";

const parameters = Type.Object({ text: Type.String() });
const metadata = { name: "composed", title: "Composed", description: "Composition fixtures", parameters };
const plain = definePortableTool({
  ...metadata,
  execute: (args) => ({ text: args.text, structuredContent: { text: args.text } }),
});
const decorated = definePortableTool({ ...plain, title: "Decorated" });
definePortableTool(plain);

const annotated: PortableTool<typeof parameters, { text: string }> = {
  ...metadata,
  execute: (args) => ({ text: args.text }),
};
definePortableTool(annotated);
definePortableTool<typeof parameters, { text: string }>(annotated);
// Explicit legacy function generics intentionally erase schema specificity too;
// runtime validation is the remaining guard, even for a concrete inline schema.
definePortableTool<typeof parameters, PortableToolResult>({
  ...metadata,
  outputSchema: Type.Object({ text: Type.String() }),
  execute: () => ({ text: "bad", structuredContent: { text: 42 } }),
});

function withTitle<P extends TSchema, R extends PortableToolResult>(tool: PortableTool<P, R>) {
  return definePortableTool({ ...tool, title: "Decorated" });
}
const generic = withTitle(plain);

const schema = Type.Object({ text: Type.String() });
const declared = definePortableTool({
  ...metadata,
  outputSchema: schema,
  execute: (args) => ({ text: args.text, structuredContent: { text: args.text, retained: 1 } }),
});
const declaredAgain = definePortableTool({ ...declared, title: "Decorated" });
definePortableTool(declared);
definePortableTool({ ...declared, execute: () => ({ text: "ok", structuredContent: { text: "ok" } }) });
// @ts-expect-error a valid schema-bearing spread cannot replace its success handler with incompatible data
definePortableTool({ ...declared, execute: () => ({ text: "bad", structuredContent: { text: 42 } }) });
// @ts-expect-error inline concrete output schemas must not escape checking through compatibility overloads
definePortableTool({
  ...metadata,
  outputSchema: schema,
  execute: () => ({ text: "bad", structuredContent: { text: 42 } }),
});

const precise: PortableTool<typeof parameters, { text: string; structuredContent: { text: string } }, typeof schema> =
  declared;
const composedPrecise = definePortableTool(precise);
definePortableTool({ ...precise, title: "Precise" });
// @ts-expect-error optional schema presence in a precise annotation still constrains successful output
definePortableTool({ ...precise, execute: () => ({ text: "bad", structuredContent: { text: 42 } }) });

async function results(): Promise<void> {
  for (const tool of [decorated, generic]) {
    const result = await executePortableTool(tool, { text: "ok" }, { host: "test" });
    if (result.isError !== true) {
      const text: string = result.structuredContent.text;
      void text;
    }
  }
  const result = await executePortableTool(declaredAgain, { text: "ok" }, { host: "test" });
  if (result.isError !== true) {
    const retained: number = result.structuredContent.retained;
    void retained;
  }
  const preciseResult = await executePortableTool(composedPrecise, { text: "ok" }, { host: "test" });
  if (preciseResult.isError !== true) {
    const text: string = preciseResult.structuredContent.text;
    void text;
  }
}
void results;
