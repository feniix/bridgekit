import type { TSchema } from "typebox";
import type {
  PortableTool,
  PortableToolErrorDetails,
  PortableToolResult,
  PortableValidationError,
} from "../core/define-tool.js";
import { executePortableTool } from "../core/execute-tool.js";

type PiContent = { type: "text"; text: string };

type PiToolUpdate = { content: PiContent[]; details: Record<string, unknown> };
type PiToolResult = { content: PiContent[]; details: Record<string, unknown> };

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

function toPiDetails(result: PortableToolResult): Record<string, unknown> {
  return result.structuredContent ?? result.details ?? {};
}

function isValidationDetails(
  source: Record<string, unknown>,
): source is { kind: "validation"; tool: string; validationErrors: PortableValidationError[] } {
  return source.kind === "validation" && typeof source.tool === "string" && Array.isArray(source.validationErrors);
}

function toPortableToolErrorDetails(result: PortableToolResult): PortableToolErrorDetails {
  const source = toPiDetails(result);
  if (isValidationDetails(source)) {
    return source;
  }
  const { kind: _ignored, ...rest } = source;
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

export function registerPiTools(pi: PiToolRegistration, tools: readonly PortableTool<TSchema>[]): void {
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        const result = await executePortableTool(tool, params, {
          host: "pi",
          signal,
          progress(update) {
            onUpdate?.({
              content: [{ type: "text", text: update.text } satisfies PiContent],
              details: toPiDetails(update),
            });
          },
        });

        if (result.isError) {
          throw new PortableToolExecutionError(result);
        }

        return {
          content: [{ type: "text", text: result.text } satisfies PiContent],
          details: toPiDetails(result),
        };
      },
    });
  }
}
