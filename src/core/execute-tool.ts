import { Check, Errors } from "typebox/value";
import type { TSchema } from "typebox";
import type {
  PortableTool,
  PortableToolBuiltInHost,
  PortableToolContext,
  PortableToolResult,
} from "./define-tool.js";

export interface PortableValidationError {
  path: string;
  message: string;
}

export function validatePortableToolArgs<THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TSchema, THost>,
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

export async function executePortableTool<THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TSchema, THost>,
  args: unknown,
  ctx: PortableToolContext<NoInfer<THost>>,
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
