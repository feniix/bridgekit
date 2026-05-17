import type { Static, TSchema } from "typebox";

export interface PortableToolResult {
  /** Plain text sent back to the model in every host. */
  text: string;
  /** Structured data for hosts that support it. Preferred by both pi and MCP adapters. */
  structuredContent?: Record<string, unknown>;
  /** Legacy/adapter debug details used only when structuredContent is absent. */
  details?: Record<string, unknown>;
  /** Tool-level error flag. Throw for unexpected adapter/runtime failures. */
  isError?: boolean;
}

export interface PortableToolContext {
  host: "pi" | "mcp" | "test";
  signal?: AbortSignal;
  progress?: (update: PortableToolResult) => void;
}

export interface PortableTool<TParams extends TSchema = TSchema> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute(
    args: Static<TParams>,
    ctx: PortableToolContext,
  ): PortableToolResult | Promise<PortableToolResult>;
}

export function definePortableTool<TParams extends TSchema>(tool: PortableTool<TParams>): PortableTool<TParams> {
  return tool;
}
