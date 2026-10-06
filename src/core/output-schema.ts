import type { TSchema } from "typebox";
import type { PortableTool, PortableToolResult } from "./define-tool.js";

/** Follow JSON Schema structure rather than TypeBox-specific symbols. */
export function isObjectSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { $ref?: unknown; type?: unknown; allOf?: unknown };
  if (typeof candidate.$ref === "string") return false;
  if (candidate.type === "object") return true;
  return Array.isArray(candidate.allOf) && candidate.allOf.length > 0 && candidate.allOf.every(isObjectSchema);
}

/** Identify the first unsupported root/branch for an actionable schema diagnostic. */
export function schemaTypeLabel(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "unknown";
  const candidate = schema as {
    $ref?: unknown;
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
  };
  if (typeof candidate.$ref === "string") return "$ref";
  if (typeof candidate.type === "string") return candidate.type;
  if (Array.isArray(candidate.anyOf)) return "anyOf";
  if (Array.isArray(candidate.oneOf)) return "oneOf";
  if (Array.isArray(candidate.allOf)) {
    if (candidate.allOf.length === 0) return "allOf (empty)";
    for (let i = 0; i < candidate.allOf.length; i++) {
      if (!isObjectSchema(candidate.allOf[i])) {
        return `allOf[${i}] resolves to type="${schemaTypeLabel(candidate.allOf[i])}"`;
      }
    }
  }
  return "unknown";
}

export function throwWithCode(message: string, code: string, ErrorType: ErrorConstructor = Error): never {
  const error = new ErrorType(message) as Error & { code: string };
  error.code = code;
  throw error;
}

/**
 * Output schemas may use any JSON Schema root (object, array, primitive,
 * union); the MCP SDK projects non-object roots for legacy clients. Only a
 * top-level `$ref` is rejected: `tools/list` ships schemas by value and clients
 * do not resolve references.
 */
export function assertPortableOutputSchema(
  tool: PortableTool<TSchema, PortableToolResult<unknown>>,
  context?: string,
  codePrefix = "BRIDGEKIT",
): void {
  const schema = tool.outputSchema as { $ref?: unknown } | undefined;
  if (schema !== undefined && typeof schema.$ref === "string") {
    throwWithCode(
      `${context ? `${context}: ` : ""}Invalid outputSchema for ${tool.name} (type="$ref"): ` +
        "Top-level $ref / Type.Cyclic is unsupported; inline the referenced shape or split recursive shapes.",
      `${codePrefix}_REF_OUTPUT_SCHEMA`,
      TypeError,
    );
  }
}
