import type { Static, TSchema } from "typebox";

export interface PortableToolResult<TStructured extends Record<string, unknown> = Record<string, unknown>> {
  /** Plain text sent back to the model in every host. */
  text: string;
  /** Structured data for hosts that support it. Preferred by both pi and MCP adapters. */
  structuredContent?: TStructured;
  /**
   * Legacy/adapter debug details used only when `structuredContent` is absent.
   *
   * @deprecated Slated for removal in 1.0. Prefer `structuredContent` for
   * machine-readable data. Both adapters still fall back to this field, but
   * new tool code should not set it.
   */
  details?: Record<string, unknown>;
  /** Tool-level error flag. Throw for unexpected adapter/runtime failures. */
  isError?: boolean;
}

/**
 * Discriminated union describing the shape `executePortableTool` puts into a
 * failure result's `structuredContent`, and that the pi adapter exposes as
 * `PortableToolExecutionError.details`.
 *
 * - `kind: "validation"` — TypeBox rejected the args. Always carries the
 *   offending tool name and the validation errors.
 * - `kind: "domain"` — the tool's own handler returned `isError: true`. The
 *   shape of the rest of the object is whatever the handler chose to expose.
 */
export type PortableToolErrorDetails =
  | { kind: "validation"; tool: string; validationErrors: PortableValidationError[] }
  | ({ kind: "domain" } & Record<string, unknown>);

export interface PortableValidationError {
  field: string;
  message: string;
}

export type PortableToolBuiltInHost = "pi" | "mcp" | "test";

export type PortableToolHost<TExtension extends string = never> = PortableToolBuiltInHost | TExtension;

export interface PortableToolContext<THost extends string = PortableToolBuiltInHost> {
  host: THost;
  signal?: AbortSignal;
  progress?: (update: PortableToolResult) => void;
}

export interface PortableTool<TParams extends TSchema = TSchema, THost extends string = PortableToolBuiltInHost> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext<THost>) => PortableToolResult | Promise<PortableToolResult>;
}

export function definePortableTool<TParams extends TSchema, THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TParams, THost>,
): PortableTool<TParams, THost> {
  return tool;
}
