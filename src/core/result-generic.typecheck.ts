import type { PortableToolErrorDetails, PortableToolResult } from "@feniix/bridgekit";

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

function narrowsErrorDetails(details: PortableToolErrorDetails) {
  if (details.kind === "validation") {
    const tool: string = details.tool;
    const firstField: string | undefined = details.validationErrors[0]?.field;
    void tool;
    void firstField;
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
