import type { TSchema } from "typebox";
import type { PortableTool, PortableToolErrorDetails, PortableToolResult } from "../core/define-tool.js";
import { executePortableTool } from "../core/execute-tool.js";
import { isValidationFailure } from "../core/result-guards.js";

type PiContent = { type: "text"; text: string };

type PiToolUpdate = { content: PiContent[]; details: Record<string, unknown> };
type PiToolResult = {
  content: PiContent[];
  details: Record<string, unknown>;
  isError?: boolean;
};

type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: PiToolUpdate) => void,
    ctx?: unknown,
  ): Promise<PiToolResult>;
};

export type PiToolRegistration = {
  registerTool(tool: PiToolDefinition): unknown;
};

/**
 * How the pi adapter surfaces portable `isError: true` results (both
 * BridgeKit-emitted validation failures and tool-emitted domain failures).
 *
 * - `"return"` (default as of 0.7) — return `{ content, details, isError: true }`
 *   so the result mirrors the MCP adapter's `CallToolResult`. Consumers branch
 *   on `result.isError` and may narrow with `isValidationFailure` /
 *   `isDomainFailure`.
 * - `"throw"` (deprecated, scheduled for removal in 1.0) — throw
 *   `PortableToolExecutionError`. Available for one minor-version cycle so
 *   existing pi extensions can migrate without source changes. Selecting
 *   this value emits a `DeprecationWarning` (code
 *   `BRIDGEKIT_PI_THROW_DEPRECATED`) once per process.
 */
export interface RegisterPiToolsOptions {
  /**
   * Controls how `isError: true` portable results are surfaced. Defaults to
   * `"return"`. Passing `"throw"` is deprecated and will be removed in 1.0;
   * only the `"throw"` value is deprecated, not the option itself.
   *
   * @default "return"
   */
  errorHandling?: "throw" | "return";
}

function toPiDetails(result: PortableToolResult): Record<string, unknown> {
  return result.structuredContent ?? result.details ?? {};
}

function toPortableToolErrorDetails(result: PortableToolResult): PortableToolErrorDetails {
  if (isValidationFailure(result)) {
    return result.structuredContent;
  }
  const { kind: _ignored, ...rest } = toPiDetails(result);
  return { kind: "domain", ...rest };
}

export class PortableToolExecutionError extends Error {
  readonly details: PortableToolErrorDetails;

  constructor(result: PortableToolResult) {
    super(result.text);
    this.name = "PortableToolExecutionError";
    this.details = toPortableToolErrorDetails(result);
  }
}

export function isPortableToolExecutionError(error: unknown): error is PortableToolExecutionError {
  return error instanceof PortableToolExecutionError;
}

/**
 * Register a set of portable tools with a pi tool registry.
 *
 * Defaults to `errorHandling: "return"` so pi behaves like the MCP adapter:
 * portable `isError: true` results and TypeBox validation failures surface as
 * `{ content, details, isError: true }` rather than thrown exceptions. Pass
 * `{ errorHandling: "throw" }` to opt into the pre-0.7 throwing behavior for
 * one deprecation cycle.
 *
 * @example
 * // 0.7+ default: errors as data.
 * registerPiTools(pi, tools);
 *
 * @example
 * // Deprecated, but available through 0.x.
 * registerPiTools(pi, tools, { errorHandling: "throw" });
 */
let throwModeDeprecationWarned = false;

export function registerPiTools(
  pi: PiToolRegistration,
  tools: readonly PortableTool<TSchema>[],
  options: RegisterPiToolsOptions = {},
): void {
  const errorHandling = options.errorHandling ?? "return";
  if (errorHandling === "throw" && !throwModeDeprecationWarned) {
    throwModeDeprecationWarned = true;
    process.emitWarning(
      '`registerPiTools(..., { errorHandling: "throw" })` is deprecated and will be removed in 1.0. ' +
        'Migrate to the default `"return"` mode and branch on `result.isError`.',
      {
        type: "DeprecationWarning",
        code: "BRIDGEKIT_PI_THROW_DEPRECATED",
      },
    );
  }
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        let result: PortableToolResult;
        try {
          result = await executePortableTool(tool, params, {
            host: "pi",
            signal,
            progress(update) {
              onUpdate?.({
                content: [{ type: "text", text: update.text } satisfies PiContent],
                details: toPiDetails(update),
              });
            },
          });
        } catch (error) {
          if (errorHandling === "throw") {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: message } satisfies PiContent],
            details: {},
            isError: true,
          };
        }

        if (result.isError && errorHandling === "throw") {
          throw new PortableToolExecutionError(result);
        }

        return {
          content: [{ type: "text", text: result.text } satisfies PiContent],
          details: toPiDetails(result),
          isError: result.isError === true,
        };
      },
    });
  }
}
