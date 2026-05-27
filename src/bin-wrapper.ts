import { type BinWrapperOptions, defaultBinWrapperDeps, runBinWrapperWithDeps } from "./bin-wrapper-internal.js";

export type { BinWrapperOptions } from "./bin-wrapper-internal.js";

/**
 * Helper for an npm `bin` script that needs to load a compiled MCP entrypoint
 * and build it on first invocation (workspace/local execution) when the
 * compiled output is missing.
 *
 * Replaces the ~25-line "resolve dist path -> spawn build if missing ->
 * import and run" boilerplate shipped in `examples/README.md` since 0.4.x.
 *
 * The MCP entry module must export `runServer(): Promise<void>`. Consumers
 * with a different name can re-export under that alias.
 *
 * @example
 * ```ts
 * #!/usr/bin/env node
 * import { runBinWrapper } from "@feniix/bridgekit/bin-wrapper";
 * await runBinWrapper({
 *   metaUrl: import.meta.url,
 *   mcpEntry: "dist/extensions/mcp-server.js",
 *   buildScript: "build:mcp",
 * });
 * ```
 */
export async function runBinWrapper(options: BinWrapperOptions): Promise<void> {
  return runBinWrapperWithDeps(options, defaultBinWrapperDeps);
}
