import type { PortableToolResult, PortableValidationError } from "./define-tool.js";

/**
 * Validation-failure narrowing of `PortableToolResult`.
 *
 * `executePortableTool` produces this shape when TypeBox rejects the args:
 * `structuredContent` carries `kind: "validation"`, the offending tool name,
 * and the list of validation errors. The flag is also set to `isError: true`.
 *
 * This is the typed form a consumer can match against in both pi (default
 * `errorHandling: "return"`) and MCP adapters.
 */
export type PortableValidationFailure = PortableToolResult & {
  isError: true;
  structuredContent: {
    kind: "validation";
    tool: string;
    validationErrors: PortableValidationError[];
  };
};

/**
 * Domain-failure narrowing of `PortableToolResult`.
 *
 * Any `result.isError === true` that is not a validation failure is treated
 * as a domain failure. `structuredContent` stays whatever the handler chose;
 * the guard does not synthesize a `kind: "domain"` discriminator on the wire.
 * (The pi adapter's `PortableToolExecutionError.details` does synthesize that
 * discriminator for the deprecated `errorHandling: "throw"` path.)
 */
export type PortableDomainFailure = PortableToolResult & { isError: true };

/**
 * Type guard for results produced by `executePortableTool` when TypeBox
 * validation rejected the args.
 *
 * @example
 * const result = await executePortableTool(tool, args, ctx);
 * if (result.isError) {
 *   if (isValidationFailure(result)) {
 *     log.warn({ errors: result.structuredContent.validationErrors }, "bad args");
 *   }
 * }
 */
export function isValidationFailure(result: PortableToolResult): result is PortableValidationFailure {
  if (result.isError !== true) return false;
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object") return false;
  return (
    (structured as { kind?: unknown }).kind === "validation" &&
    typeof (structured as { tool?: unknown }).tool === "string" &&
    Array.isArray((structured as { validationErrors?: unknown }).validationErrors)
  );
}

/**
 * Type guard for handler-emitted `isError: true` results that are not
 * validation failures. Use after `result.isError` to branch between
 * BridgeKit-emitted validation failures and tool-emitted domain failures.
 *
 * @example
 * const result = await executePortableTool(tool, args, ctx);
 * if (isDomainFailure(result)) {
 *   metrics.increment("tool.domain_error", { tool: tool.name });
 * }
 */
export function isDomainFailure(result: PortableToolResult): result is PortableDomainFailure {
  return result.isError === true && !isValidationFailure(result);
}
