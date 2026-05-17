import type { TSchema } from "typebox";
import type { PortableTool, PortableToolResult } from "../core/define-tool.js";
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
  return result.details ?? result.structuredContent ?? {};
}

export class PortableToolExecutionError extends Error {
  readonly details: Record<string, unknown>;

  constructor(result: PortableToolResult) {
    super(result.text);
    this.name = "PortableToolExecutionError";
    this.details = toPiDetails(result);
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
