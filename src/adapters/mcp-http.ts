import { type CreateMcpHandlerOptions, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { type CreateMcpServerOptions, createMcpServerFactory } from "./mcp.js";

export type CreateMcpHttpHandlerOptions = CreateMcpHandlerOptions;
export type { McpHttpHandler };

/**
 * Web-standard HTTP serving; no listener, authentication, or origin policy is
 * installed. Applications must enforce those before calling `handler.fetch`.
 * Defaults to modern serving plus the SDK's stateless legacy fallback.
 */
export function createMcpHttpHandler(
  options: CreateMcpServerOptions,
  httpOptions: CreateMcpHttpHandlerOptions = {},
): McpHttpHandler {
  const factory = createMcpServerFactory(options);
  return createMcpHandler(factory, {
    ...httpOptions,
    onerror: httpOptions.onerror ?? ((error) => process.stderr.write(`[bridgekit-mcp] ${error.message}\n`)),
  });
}
