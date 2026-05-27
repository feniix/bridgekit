import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
// Surface check: the public API resolves through the package exports map.
import { runBinWrapper } from "@feniix/bridgekit/bin-wrapper";
import {
  type BinWrapperDeps,
  type BinWrapperOptions,
  type BinWrapperSpawnSync,
  defaultBinWrapperDeps,
  runBinWrapperWithDeps,
} from "./bin-wrapper-internal.js";

// Public smoke check — the package surface still exports a callable function.
// The behavior tests below exercise runBinWrapperWithDeps directly so they can
// inject deps without polluting the public BinWrapperOptions shape.
test("public surface: runBinWrapper is a callable function", () => {
  assert.equal(typeof runBinWrapper, "function");
});

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

function fakeSpawnResult(status: number | null, signal: NodeJS.Signals | null = null): SpawnSyncReturns<Buffer> {
  return { status, signal, output: [], pid: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
}

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

function makeOptions(
  fx: ReturnType<typeof makeFixture>,
  overrides: Partial<BinWrapperOptions> = {},
): BinWrapperOptions {
  return {
    metaUrl: fx.metaUrl,
    mcpEntry: fx.entryRelPath,
    buildScript: "build:mcp",
    ...overrides,
  };
}

test("entry exists -> pass-through; spawnSync is not called", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  fx.writeEntry(
    `import { writeFileSync } from "node:fs";\n` +
      `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`,
  );

  let spawnCalls = 0;
  try {
    const deps: BinWrapperDeps = {
      spawnSync: (() => {
        spawnCalls += 1;
        return fakeSpawnResult(0);
      }) satisfies BinWrapperSpawnSync,
      exit: defaultBinWrapperDeps.exit,
    };
    await runBinWrapperWithDeps(makeOptions(fx), deps);

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

  assert.equal(existsSync(fx.entryAbsPath), false);

  let spawnCalls = 0;
  let spawnArgs: { command?: string; args?: readonly string[]; cwd?: unknown; shell?: unknown } = {};

  try {
    const deps: BinWrapperDeps = {
      spawnSync: (command, args, options) => {
        spawnCalls += 1;
        spawnArgs = {
          command,
          args,
          cwd: options.cwd,
          shell: options.shell,
        };
        fx.writeEntry(entrySource);
        return fakeSpawnResult(0);
      },
      exit: defaultBinWrapperDeps.exit,
    };
    await runBinWrapperWithDeps(makeOptions(fx), deps);

    assert.equal(spawnCalls, 1);
    assert.equal(spawnArgs.command, "npm");
    assert.deepEqual(spawnArgs.args, ["run", "build:mcp", "--silent"]);
    assert.equal(spawnArgs.cwd, resolve(dirname(fileURLToPath(fx.metaUrl)), ".."));
    assert.equal(spawnArgs.shell, process.platform === "win32");
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
      const deps: BinWrapperDeps = {
        spawnSync: () => fakeSpawnResult(2),
        exit: exitStub(),
      };
      await runBinWrapperWithDeps(makeOptions(fx), deps);
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

test("entry missing -> build exits non-zero but artifact produced -> pass-through (recovery)", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  const entrySource =
    `import { writeFileSync } from "node:fs";\n` +
    `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`;

  try {
    const deps: BinWrapperDeps = {
      spawnSync: () => {
        // Simulate a build that emitted the entry but exited non-zero
        // (e.g. tsc emitted .js then reported a post-emit diagnostic).
        fx.writeEntry(entrySource);
        return fakeSpawnResult(2);
      },
      exit: exitStub(),
    };
    await runBinWrapperWithDeps(makeOptions(fx), deps);

    assert.equal(existsSync(flagFile), true, "runServer must run when the entry was produced");
  } finally {
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
      const deps: BinWrapperDeps = {
        spawnSync: () => fakeSpawnResult(0),
        exit: exitStub(),
      };
      await runBinWrapperWithDeps(makeOptions(fx), deps);
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
    await assert.rejects(runBinWrapperWithDeps(makeOptions(fx), defaultBinWrapperDeps), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[bridgekit\/bin-wrapper\] entry/);
      assert.match(error.message, /does not export a runServer\(\) function/);
      assert.match(error.message, /export async function runServer\(\)/);
      return true;
    });
  } finally {
    fx.cleanup();
  }
});
