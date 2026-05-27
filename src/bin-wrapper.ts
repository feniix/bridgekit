import { spawnSync as defaultSpawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Narrow purpose-built signature for the {@link BinWrapperOptions._spawnSync}
 * seam. The helper only invokes one `spawnSync` overload; the seam declares
 * exactly that overload rather than the full overload set so test fakes do
 * not need to satisfy unrelated variants.
 */
type SpawnSyncSeam = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer | string>;

/**
 * Options for {@link runBinWrapper}.
 *
 * Only `metaUrl`, `mcpEntry`, and `buildScript` are required. `buildTimeoutMs`
 * and `logPrefix` have sensible defaults; consumers typically vary only the
 * first three.
 */
export interface BinWrapperOptions {
  /**
   * `import.meta.url` of the bin script. Used to locate the package root
   * (the bin's parent directory). Passing the helper's own `import.meta.url`
   * would resolve the wrong package, which is why the caller must supply this.
   */
  metaUrl: string;
  /**
   * Path to the compiled MCP entry, relative to the package root.
   *
   * @example "dist/extensions/mcp-server.js"
   */
  mcpEntry: string;
  /**
   * npm script to invoke when the entry is missing.
   *
   * @example "build:mcp"
   */
  buildScript: string;
  /** Build timeout in milliseconds. Default: 60_000. */
  buildTimeoutMs?: number;
  /** Logger prefix for the "build failed" diagnostic. Default: "bridgekit-bin". */
  logPrefix?: string;
  /**
   * @internal Test-only injection seam for `spawnSync`. Not part of the public
   * contract; do not rely on it.
   */
  _spawnSync?: SpawnSyncSeam;
  /**
   * @internal Test-only injection seam for `existsSync`. Not part of the public
   * contract; do not rely on it.
   */
  _existsSync?: typeof defaultExistsSync;
  /**
   * @internal Test-only injection seam for `process.exit`. Not part of the
   * public contract; do not rely on it.
   */
  _exit?: (code: number) => never;
}

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
  const spawnSync: SpawnSyncSeam = options._spawnSync ?? defaultSpawnSync;
  const existsSync = options._existsSync ?? defaultExistsSync;
  const exit = options._exit ?? ((code: number) => process.exit(code));

  const packageRoot = resolve(dirname(fileURLToPath(options.metaUrl)), "..");
  const entryPath = join(packageRoot, options.mcpEntry);

  if (!existsSync(entryPath)) {
    const build = spawnSync("npm", ["run", options.buildScript, "--silent"], {
      cwd: packageRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout: options.buildTimeoutMs ?? 60_000,
    });

    if (build.status !== 0 || !existsSync(entryPath)) {
      const prefix = options.logPrefix ?? "bridgekit-bin";
      console.error(
        `[${prefix}] Failed to build the local MCP server. Run \`npm run ${options.buildScript}\` and try again.`,
      );
      exit(build.status && build.status !== 0 ? build.status : 1);
      return;
    }
  }

  const mod = (await import(pathToFileURL(entryPath).href)) as { runServer?: unknown };
  if (typeof mod.runServer !== "function") {
    throw new Error(
      `[bridgekit/bin-wrapper] entry "${options.mcpEntry}" does not export a runServer() function. ` +
        `Make sure your MCP server module exports \`export async function runServer()\` at the top level.`,
    );
  }
  await (mod.runServer as () => Promise<void>)();
}
