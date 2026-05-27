import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BinWrapperOptions, runBinWrapper } from "@feniix/bridgekit/bin-wrapper";

type SpawnSeam = NonNullable<BinWrapperOptions["_spawnSync"]>;

/**
 * Build a temp "package" directory shaped like a real downstream consumer:
 *
 *   <root>/
 *     bin/<binName>.js   # the script that calls runBinWrapper(import.meta.url)
 *     dist/extensions/   # where the MCP entry lives (or doesn't)
 *
 * Returns the metaUrl the bin script would pass and helpers to manipulate
 * the entry file.
 */
function makeFixture(): {
  metaUrl: string;
  packageRoot: string;
  entryRelPath: string;
  entryAbsPath: string;
  writeEntry: (contents: string) => void;
  cleanup: () => void;
} {
  const tmpRoot = mkdtempSync(join(tmpdir(), "bridgekit-bin-wrapper-"));
  const binDir = join(tmpRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const binFile = join(binDir, "fixture-bin.js");
  // The bin script doesn't have to be real code on disk; we just need a valid
  // file:// URL whose parent's parent is the package root.
  writeFileSync(binFile, "// fixture bin\n");

  const entryRelPath = "dist/extensions/mcp-server.js";
  const entryAbsPath = join(tmpRoot, entryRelPath);

  return {
    metaUrl: pathToFileURL(binFile).href,
    packageRoot: tmpRoot,
    entryRelPath,
    entryAbsPath,
    writeEntry(contents) {
      mkdirSync(dirname(entryAbsPath), { recursive: true });
      writeFileSync(entryAbsPath, contents);
    },
    cleanup() {
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Build a fake `SpawnSyncReturns` with the fields the helper touches
 * (`status`). Other fields are zeroed.
 */
function fakeSpawnResult(status: number | null): SpawnSyncReturns<Buffer> {
  return { status, signal: null, output: [], pid: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
}

/**
 * Sentinel thrown by the stubbed `_exit` so tests can assert the helper
 * tried to exit with a specific code without actually exiting the test
 * runner.
 */
class ExitInvoked extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const exitStub = (): ((code: number) => never) => {
  return (code: number) => {
    throw new ExitInvoked(code);
  };
};

// Each entry module written by the fixture is unique per test (path includes
// the temp dir), so dynamic import caching across tests cannot leak state.
// We coordinate "did runServer fire?" via a tmpfile flag rather than shared
// module state so the assertions stay process-isolation-safe.

test("entry exists -> pass-through; spawnSync is not called", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  fx.writeEntry(
    `import { writeFileSync } from "node:fs";\n` +
      `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`,
  );

  let spawnCalls = 0;
  try {
    await runBinWrapper({
      metaUrl: fx.metaUrl,
      mcpEntry: fx.entryRelPath,
      buildScript: "build:mcp",
      _spawnSync: ((): SpawnSyncReturns<Buffer> => {
        spawnCalls += 1;
        return fakeSpawnResult(0);
      }) satisfies SpawnSeam,
    });

    assert.equal(spawnCalls, 0, "spawnSync must not run when the entry exists");
    assert.equal(existsSync(flagFile), true, "runServer must have been invoked");
  } finally {
    fx.cleanup();
  }
});

test("entry missing -> build succeeds -> pass-through", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  const entrySource =
    `import { writeFileSync } from "node:fs";\n` +
    `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`;

  // Pre-condition: entry does NOT exist yet.
  assert.equal(existsSync(fx.entryAbsPath), false);

  let spawnCalls = 0;
  let spawnArgs: { command?: string; args?: readonly string[]; cwd?: unknown } = {};

  try {
    await runBinWrapper({
      metaUrl: fx.metaUrl,
      mcpEntry: fx.entryRelPath,
      buildScript: "build:mcp",
      _spawnSync: (command, args, options) => {
        spawnCalls += 1;
        spawnArgs = {
          command: command as string,
          args: args as readonly string[],
          cwd: (options as { cwd?: unknown })?.cwd,
        };
        // Simulate `npm run build:mcp` materialising the entry.
        fx.writeEntry(entrySource);
        return fakeSpawnResult(0);
      },
    });

    assert.equal(spawnCalls, 1);
    assert.equal(spawnArgs.command, "npm");
    assert.deepEqual(spawnArgs.args, ["run", "build:mcp", "--silent"]);
    assert.equal(spawnArgs.cwd, resolve(dirname(fileURLToPath(fx.metaUrl)), ".."));
    assert.equal(existsSync(flagFile), true);
  } finally {
    fx.cleanup();
  }
});

test("entry missing -> build fails non-zero -> exits with build status; logs the diagnostic", async () => {
  const fx = makeFixture();
  const captured: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: unknown) => {
    captured.push(String(message));
  };

  try {
    let thrown: unknown;
    try {
      await runBinWrapper({
        metaUrl: fx.metaUrl,
        mcpEntry: fx.entryRelPath,
        buildScript: "build:mcp",
        _spawnSync: () => fakeSpawnResult(2),
        _exit: exitStub(),
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof ExitInvoked, `expected ExitInvoked, got ${thrown}`);
    assert.equal((thrown as ExitInvoked).code, 2);
    assert.equal(captured.length, 1);
    assert.match(captured[0] ?? "", /\[bridgekit-bin\] Failed to build the local MCP server/);
    assert.match(captured[0] ?? "", /npm run build:mcp/);
  } finally {
    console.error = originalConsoleError;
    fx.cleanup();
  }
});

test("entry missing -> build exits 0 but entry still missing -> exits with code 1", async () => {
  const fx = makeFixture();
  const captured: string[] = [];
  const originalConsoleError = console.error;
  console.error = (message: unknown) => {
    captured.push(String(message));
  };

  try {
    let thrown: unknown;
    try {
      await runBinWrapper({
        metaUrl: fx.metaUrl,
        mcpEntry: fx.entryRelPath,
        buildScript: "build:mcp",
        // Build reports success but doesn't actually produce the entry.
        _spawnSync: () => fakeSpawnResult(0),
        _exit: exitStub(),
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof ExitInvoked, `expected ExitInvoked, got ${thrown}`);
    assert.equal((thrown as ExitInvoked).code, 1);
    assert.equal(captured.length, 1);
    assert.match(captured[0] ?? "", /Failed to build the local MCP server/);
  } finally {
    console.error = originalConsoleError;
    fx.cleanup();
  }
});

test("entry exists but doesn't export runServer -> throws documented error", async () => {
  const fx = makeFixture();
  fx.writeEntry(`export const notRunServer = 1;\n`);

  try {
    await assert.rejects(
      runBinWrapper({
        metaUrl: fx.metaUrl,
        mcpEntry: fx.entryRelPath,
        buildScript: "build:mcp",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[bridgekit\/bin-wrapper\] entry/);
        assert.match(error.message, /does not export a runServer\(\) function/);
        assert.match(error.message, /export async function runServer\(\)/);
        return true;
      },
    );
  } finally {
    fx.cleanup();
  }
});
