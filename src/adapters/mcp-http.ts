import { type CreateMcpHandlerOptions, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { type CreateMcpServerOptions, createMcpServerFactory } from "./mcp.js";

/**
 * SDK handler options minus `legacy`: BridgeKit serves the modern
 * `2026-07-28` era only, so legacy-era requests are always rejected.
 */
export type CreateMcpHttpHandlerOptions = Omit<CreateMcpHandlerOptions, "legacy">;
export type { McpHttpHandler };

/**
 * Web-standard HTTP serving; no listener, authentication, or origin policy is
 * installed. Applications must enforce those before calling `handler.fetch`.
 * Serves the modern `2026-07-28` era only; `2025-11-25` clients receive the
 * unsupported-protocol-version error naming the supported revisions.
 */
export function createMcpHttpHandler(
  options: CreateMcpServerOptions,
  httpOptions: CreateMcpHttpHandlerOptions = {},
): McpHttpHandler {
  const factory = createMcpServerFactory(options);
  return createMcpHandler(factory, {
    ...httpOptions,
    legacy: "reject",
    onerror: httpOptions.onerror ?? ((error) => process.stderr.write(`[bridgekit-mcp] ${error.message}\n`)),
  });
}
