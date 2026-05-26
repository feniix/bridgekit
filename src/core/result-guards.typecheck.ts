import {
  isDomainFailure,
  isValidationFailure,
  type PortableDomainFailure,
  type PortableToolResult,
  type PortableValidationFailure,
} from "@feniix/bridgekit";

declare const result: PortableToolResult;

// Positive narrowing: isValidationFailure narrows structuredContent to the
// validation shape so tool / validationErrors are reachable without a cast.
if (isValidationFailure(result)) {
  const narrowed: PortableValidationFailure = result;
  const tool: string = narrowed.structuredContent.tool;
  const errors = narrowed.structuredContent.validationErrors;
  void tool;
  void errors;
}

// Negative narrowing: before the guard, structuredContent.tool is not known to
// exist on PortableToolResult. The access must fail to compile.
// @ts-expect-error structuredContent.tool is not on PortableToolResult before the guard.
void result.structuredContent.tool;

// Positive narrowing: isDomainFailure narrows isError to literal true.
if (isDomainFailure(result)) {
  const narrowed: PortableDomainFailure = result;
  const flag: true = narrowed.isError;
  void flag;
}

// Negative narrowing: PortableValidationFailure is structurally a subtype of
// PortableToolResult (with isError: true), but a bare PortableToolResult is
// not assignable to PortableValidationFailure without the guard.
// @ts-expect-error A success result is not a PortableValidationFailure.
const _bad: PortableValidationFailure = result;
void _bad;

// Negative: a success-shaped literal must not satisfy isDomainFailure's narrowed type.
const success: PortableToolResult = { text: "ok" };
// @ts-expect-error A success result is not a PortableDomainFailure either.
const _badDomain: PortableDomainFailure = success;
void _badDomain;
