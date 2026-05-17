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

export type PortableToolBuiltInHost = "pi" | "mcp" | "test";

export type PortableToolHost<TExtension extends string = never> = PortableToolBuiltInHost | TExtension;

export interface PortableToolContext<THost extends string = PortableToolBuiltInHost> {
  host: THost;
  signal?: AbortSignal;
  progress?: (update: PortableToolResult) => void;
}

export interface PortableTool<TParams extends TSchema = TSchema, THost extends string = PortableToolBuiltInHost> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext<THost>) => PortableToolResult | Promise<PortableToolResult>;
}

export function definePortableTool<TParams extends TSchema, THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TParams, THost>,
): PortableTool<TParams, THost> {
  return tool;
}
