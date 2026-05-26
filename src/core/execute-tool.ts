import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Check, Errors } from "typebox/value";
import type {
  PortableTool,
  PortableToolBuiltInHost,
  PortableToolContext,
  PortableToolResult,
  PortableValidationError,
} from "./define-tool.js";

const ROOT_FIELD = "(root)";

function suppressSiblingErrorsUnderUnion(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
  // For unions of objects, TypeBox emits per-branch `required` /
  // `additionalProperties` errors at the union's path. The user only needs
  // to satisfy ONE branch, so those entries are phantoms; the `anyOf` /
  // `oneOf` summary at the same path is the real signal.
  //
  // `const` / `enum` errors at the same path survive — they carry real
  // discriminator info about which branch was intended.
  //
  // Known trade-off (#38): discriminated unions where the user picks a
  // branch correctly but forgets that branch's required props also lose
  // the "you picked tag=X and forgot Y" hint. Keyword-aware branch
  // matching is the follow-up.
  const unionPaths = new Set<string>();
  for (const error of errors) {
    if (error.keyword === "anyOf" || error.keyword === "oneOf") {
      unionPaths.add(error.instancePath);
    }
  }
  if (unionPaths.size === 0) return errors;
  return errors.filter((error) => {
    if (!unionPaths.has(error.instancePath)) return true;
    return error.keyword !== "required" && error.keyword !== "additionalProperties";
  });
}

function expandTypeBoxError(error: TLocalizedValidationError): PortableValidationError[] {
  // Read offending property names from TypeBox's structured `params` rather
  // than parsing the message string. Two payoffs: locale independence (the
  // helper works the same after `Locale.Set("de_DE")`), and faithful
  // preservation of property names that contain delimiters TypeBox's prose
  // would split on (commas, etc.).
  if (error.keyword === "required") {
    const props = error.params.requiredProperties.filter((p) => p.length > 0);
    if (props.length > 0) {
      return props.map((field) => ({
        field,
        message: `must have required property ${field}`,
      }));
    }
  }
  if (error.keyword === "additionalProperties") {
    const props = error.params.additionalProperties.filter((p) => p.length > 0);
    if (props.length > 0) {
      return props.map((field) => ({
        field,
        message: `must not have additional property ${field}`,
      }));
    }
  }

  const segments = error.instancePath.split("/").filter(Boolean);
  return [{ field: segments.at(-1) ?? ROOT_FIELD, message: error.message }];
}

export function validatePortableToolArgs<THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TSchema, THost>,
  args: unknown,
): { ok: true } | { ok: false; errors: PortableValidationError[] } {
  if (Check(tool.parameters, args)) {
    return { ok: true };
  }

  // TypeBox can emit multiple errors per offending field (e.g. union/anyOf
  // mismatches fire one error per failed branch). First, when an anyOf/oneOf
  // error fires at a path, drop sibling `required`/`additionalProperties`
  // errors at the same path — they're phantoms (the consumer only needs to
  // satisfy ONE branch, not all of them). Then dedupe the survivors by
  // (field, message) using JSON.stringify so the key can't collide regardless
  // of what characters field or message contain.
  const rawErrors = suppressSiblingErrorsUnderUnion([...Errors(tool.parameters, args)] as TLocalizedValidationError[]);
  const seen = new Set<string>();
  const errors = rawErrors
    .flatMap((error) => expandTypeBoxError(error))
    .filter(({ field, message }) => {
      const key = JSON.stringify([field, message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { ok: false, errors };
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
