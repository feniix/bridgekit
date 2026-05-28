import {
  definePortableTool,
  executePortableTool,
  type PortableToolErrorDetails,
  type PortableToolResult,
} from "@feniix/bridgekit";
import { Type } from "typebox";

/**
 * Compile-only assertions for the `TStructured` generic on `PortableToolResult`
 * and the discriminated `PortableToolErrorDetails` union. This file is never
 * executed; the build is the assertion.
 */

const narrowed: PortableToolResult<{ output: string }> = { text: "hi", structuredContent: { output: "hi" } };
const narrowedOutput: string = narrowed.structuredContent?.output ?? "";
void narrowedOutput;

// @ts-expect-error structuredContent must satisfy the declared TStructured shape.
const wrongValueType: PortableToolResult<{ output: string }> = { text: "hi", structuredContent: { output: 42 } };
void wrongValueType;

const loose: PortableToolResult = { text: "hi", structuredContent: { anything: 1, somethingElse: "ok" } };
void loose;

const inferredResultTool = definePortableTool({
  name: "inferred_result",
  title: "Inferred Result",
  description: "Typecheck fixture for inferred structuredContent.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args) {
    return { text: args.text, structuredContent: { output: args.text, count: args.text.length } };
  },
});

async function preservesInferredStructuredContent(): Promise<void> {
  const result = await executePortableTool(inferredResultTool, { text: "hi" }, { host: "test" });
  if (result.isError !== true) {
    const output: string = result.structuredContent.output;
    const count: number = result.structuredContent.count;
    void output;
    void count;
    // @ts-expect-error unknown keys are not present on the inferred success structuredContent.
    const missing = result.structuredContent.missing;
    void missing;
  }
}
void preservesInferredStructuredContent;

function narrowsErrorDetails(details: PortableToolErrorDetails) {
  if (details.kind === "validation") {
    const tool: string = details.tool;
    const firstField: string | undefined = details.validationErrors[0]?.field;
    void tool;
    void firstField;
    // @ts-expect-error `path` was renamed to `field` in 0.8.0 and is no longer part of the type.
    const _legacyPath: string | undefined = details.validationErrors[0]?.path;
    void _legacyPath;
  } else {
    const kind: "domain" = details.kind;
    void kind;
  }
}
void narrowsErrorDetails;

function requiresNarrowingForTypedAccess(details: PortableToolErrorDetails) {
  // @ts-expect-error Without narrowing on `kind`, validationErrors is `unknown` and is not indexable.
  const field = details.validationErrors[0].field;
  void field;
}
void requiresNarrowingForTypedAccess;
