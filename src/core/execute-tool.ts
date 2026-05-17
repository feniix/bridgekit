import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import type { PortableTool, PortableToolContext, PortableToolResult } from "./define-tool.js";

export interface PortableValidationError {
  path: string;
  message: string;
}

export function validatePortableToolArgs(
  tool: PortableTool<TSchema>,
  args: unknown,
): { ok: true } | { ok: false; errors: PortableValidationError[] } {
  if (Check(tool.parameters, args)) {
    return { ok: true };
  }

  return {
    ok: false,
    errors: [...Errors(tool.parameters, args)].map((error) => ({
      path: error.instancePath || "/",
      message: error.message,
    })),
  };
}

export async function executePortableTool(
  tool: PortableTool<TSchema>,
  args: unknown,
  ctx: PortableToolContext,
): Promise<PortableToolResult> {
  const validation = validatePortableToolArgs(tool, args);
  if (!validation.ok) {
    return {
      text: `Invalid arguments for ${tool.name}: ${validation.errors
        .map((error) => `${error.path} ${error.message}`)
        .join("; ")}`,
      structuredContent: {
        tool: tool.name,
        validationErrors: validation.errors,
      },
      isError: true,
    };
  }

  return tool.execute(args as never, ctx);
}
