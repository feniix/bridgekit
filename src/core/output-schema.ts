import type { PortableTool } from "./define-tool.js";

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

export function assertPortableOutputSchema(tool: PortableTool, context?: string, codePrefix = "BRIDGEKIT"): void {
  if (tool.outputSchema !== undefined && !isObjectSchema(tool.outputSchema)) {
    const label = schemaTypeLabel(tool.outputSchema);
    let recipe = "Use an inlined object schema or an intersection of object schemas.";
    if (label.includes("$ref")) {
      recipe += " Top-level $ref / Type.Cyclic is unsupported; inline the referenced shape or split recursive shapes.";
    } else if (label.includes("anyOf") || label.includes("oneOf")) {
      recipe += " Top-level unions are unsupported; flatten branches into one object or expose separate tools.";
    }
    throwWithCode(
      `${context ? `${context}: ` : ""}Invalid outputSchema for ${tool.name} (type="${label}"): ${recipe}`,
      `${codePrefix}_${label.includes("$ref") ? "REF" : "NON_OBJECT"}_OUTPUT_SCHEMA`,
      TypeError,
    );
  }
}
