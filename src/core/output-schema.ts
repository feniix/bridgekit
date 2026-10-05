import type { PortableTool } from "./define-tool.js";

/** Follow JSON Schema structure rather than TypeBox-specific symbols. */
export function isObjectSchema(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const candidate = schema as { $ref?: unknown; type?: unknown; allOf?: unknown };
  if (typeof candidate.$ref === "string") return false;
  if (candidate.type === "object") return true;
  return Array.isArray(candidate.allOf) && candidate.allOf.length > 0 && candidate.allOf.every(isObjectSchema);
}

export function assertPortableOutputSchema(tool: PortableTool): void {
  if (tool.outputSchema !== undefined && !isObjectSchema(tool.outputSchema)) {
    throw new TypeError(
      `Invalid outputSchema for ${tool.name}: use an inlined object schema or an intersection of object schemas.`,
    );
  }
}
