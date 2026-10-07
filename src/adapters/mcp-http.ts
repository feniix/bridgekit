import { type CreateMcpHandlerOptions, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { type CreateMcpServerOptions, createMcpServerFactory } from "./mcp.js";

/**
 * Web-standard HTTP serving; no listener, authentication, or origin policy is
 * installed. Applications must enforce those before calling `handler.fetch`.
 * Defaults to modern serving plus the SDK's stateless legacy fallback.
 */
export function createMcpHttpHandler(
  options: CreateMcpServerOptions,
  httpOptions: CreateMcpHandlerOptions = {},
): McpHttpHandler {
  const factory = createMcpServerFactory(options);
  return createMcpHandler(factory, httpOptions);
}
