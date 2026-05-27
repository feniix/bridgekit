// Internal implementation of bin-wrapper. Ships in the published tarball
// (the public `bin-wrapper.js` imports from it at runtime) but is not
// reachable via package.json#exports — deep-importing this module by name
// fails with ERR_PACKAGE_PATH_NOT_EXPORTED (pinned by scripts/smoke-package.mjs
// under inv-deep-imports-fail).

import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Narrow purpose-built signature. The helper only invokes one spawnSync
// overload; the seam declares exactly that overload rather than the full
// overload set so test fakes do not need to satisfy unrelated variants.
export type BinWrapperSpawnSync = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

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
   * Must be a literal in the caller's source. The helper does not contain
   * arbitrary paths — sourcing this from CLI args or env vars exposes the
   * dynamic `import()` to attacker-controlled file paths.
   *
   * @example "dist/extensions/mcp-server.js"
   */
  mcpEntry: string;
  /**
   * npm script to invoke when the entry is missing.
   *
   * Must be a literal in the caller's source. On Windows the helper sets
   * `shell: true` for `spawnSync`, which makes `&`, `|`, and `^` shell
   * metacharacters; sourcing this from CLI args or env vars opens a
   * command-injection vector on Windows.
   *
   * @example "build:mcp"
   */
  buildScript: string;
  buildTimeoutMs?: number;
  logPrefix?: string;
}

export interface BinWrapperDeps {
  spawnSync: BinWrapperSpawnSync;
  exit: (code: number) => never;
}

const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const DEFAULT_LOG_PREFIX = "bridgekit-bin";

export const defaultBinWrapperDeps: BinWrapperDeps = {
  spawnSync,
  exit: process.exit,
};

export async function runBinWrapperWithDeps(options: BinWrapperOptions, deps: BinWrapperDeps): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(options.metaUrl)), "..");
  const entryPath = join(packageRoot, options.mcpEntry);

  if (!existsSync(entryPath)) {
    const timeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const build = deps.spawnSync("npm", ["run", options.buildScript, "--silent"], {
      cwd: packageRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout: timeoutMs,
    });

    // File presence is the load-bearing signal: a build that exits non-zero
    // *after* emitting the entry (e.g. tsc with a post-emit diagnostic, or a
    // build pipeline whose final step is non-fatal lint/test) is still
    // recoverable. Only bail if the artifact we need is actually missing.
    if (!existsSync(entryPath)) {
      const prefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
      // A child killed by the timeout returns status: null + signal set.
      // Distinguish that from a build error so the operator sees the actual
      // cause and knows about buildTimeoutMs.
      if (build.signal !== null) {
        console.error(
          `[${prefix}] Build timed out after ${timeoutMs}ms (signal ${build.signal}). ` +
            `Raise buildTimeoutMs or run \`npm run ${options.buildScript}\` manually.`,
        );
        deps.exit(1);
      } else {
        console.error(
          `[${prefix}] Failed to build the local MCP server. Run \`npm run ${options.buildScript}\` and try again.`,
        );
        // Propagate the build's non-zero status if present; fall back to 1
        // when status===0 with missing entry or status===null without signal.
        deps.exit(build.status !== null && build.status !== 0 ? build.status : 1);
      }
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
