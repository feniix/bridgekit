import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type {
  PortableTool,
  PortableToolBuiltInHost,
  PortableToolContext,
  PortableToolResult,
  PortableValidationError,
} from "./define-tool.js";

const REQUIRED_PROPS_MESSAGE = /^must have required propert(?:y|ies) (.+)$/;

function expandTypeBoxError(error: { instancePath: string; message: string }): PortableValidationError[] {
  // "must have required properties X, Y" — emit one error per missing prop so
  // consumers get a normalized `{ field, message }` per missing field instead
  // of a single error whose message lists several. Also applies to nested
  // required-property errors (e.g. instancePath `/inner`, message naming the
  // child prop) — in those cases the child prop is more useful as `field`
  // than the parent path segment.
  const match = REQUIRED_PROPS_MESSAGE.exec(error.message);
  if (match) {
    const props = match[1]
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (props.length > 0) {
      return props.map((field) => ({
        field,
        message: `must have required property ${field}`,
      }));
    }
  }

  const segments = error.instancePath.split("/").filter(Boolean);
  return [{ field: segments[segments.length - 1] ?? "", message: error.message }];
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
    errors: [...Errors(tool.parameters, args)].flatMap(expandTypeBoxError),
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
        .map((error) => `${error.field}: ${error.message}`)
        .join("; ")}`,
      structuredContent: {
        kind: "validation",
        tool: tool.name,
        validationErrors: validation.errors,
      },
      isError: true,
    };
  }

  return tool.execute(args as never, ctx);
}
