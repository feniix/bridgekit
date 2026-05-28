import assert from "node:assert/strict";
import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
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

const exitStub: (code: number) => never = (code) => {
  throw new ExitInvoked(code);
};

function captureConsoleError(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  const original = console.error;
  console.error = (message: unknown) => {
    captured.push(String(message));
  };
  return {
    captured,
    restore: () => {
      console.error = original;
    },
  };
}

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

test("rejects unsafe mcpEntry values before spawning or importing", async () => {
  const fx = makeFixture();
  let spawnCalls = 0;

  try {
    const deps: BinWrapperDeps = {
      spawnSync: (() => {
        spawnCalls += 1;
        return fakeSpawnResult(0);
      }) satisfies BinWrapperSpawnSync,
      exit: exitStub,
    };

    for (const mcpEntry of [
      "",
      "/tmp/server.js",
      "../server.js",
      "dist/../server.js",
      "C:\\temp\\server.js",
      "dist/server\0.js",
    ]) {
      await assert.rejects(runBinWrapperWithDeps(makeOptions(fx, { mcpEntry }), deps), /mcpEntry/);
    }

    assert.equal(spawnCalls, 0, "unsafe mcpEntry values must fail before running npm");
  } finally {
    fx.cleanup();
  }
});

test("rejects unsafe buildScript values before spawning", async () => {
  const fx = makeFixture();
  let spawnCalls = 0;

  try {
    const deps: BinWrapperDeps = {
      spawnSync: (() => {
        spawnCalls += 1;
        return fakeSpawnResult(0);
      }) satisfies BinWrapperSpawnSync,
      exit: exitStub,
    };

    for (const buildScript of ["", "-build", "build mcp", "build:mcp && rm -rf /", "build/mcp", "build^mcp"]) {
      await assert.rejects(runBinWrapperWithDeps(makeOptions(fx, { buildScript }), deps), /buildScript/);
    }

    assert.equal(spawnCalls, 0, "unsafe buildScript values must fail before running npm");
  } finally {
    fx.cleanup();
  }
});

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
  let spawnArgs: {
    command?: string;
    args?: readonly string[];
    cwd?: unknown;
    shell?: unknown;
    timeout?: unknown;
    stdio?: SpawnSyncOptions["stdio"];
  } = {};

  try {
    const deps: BinWrapperDeps = {
      spawnSync: (command, args, options) => {
        spawnCalls += 1;
        spawnArgs = {
          command,
          args,
          cwd: options.cwd,
          shell: options.shell,
          timeout: options.timeout,
          stdio: options.stdio,
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
    assert.equal(spawnArgs.cwd, fx.packageRoot);
    assert.equal(spawnArgs.shell, process.platform === "win32");
    // Pin the default: 60_000ms. Documented in examples/README.md as part of the public contract.
    assert.equal(spawnArgs.timeout, 60_000);
    // Pin the buildStdio default: `"inherit"`. Existing consumers that adopted
    // runBinWrapper before 0.13.0 rely on this; do not change without a
    // breaking-version bump and a migration note.
    assert.equal(spawnArgs.stdio, "inherit");
    assert.equal(existsSync(flagFile), true);
  } finally {
    fx.cleanup();
  }
});

test("buildStdio override propagates to spawnSync (MCP-stdio-bin pattern)", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  const entrySource =
    `import { writeFileSync } from "node:fs";\n` +
    `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`;

  // The canonical MCP-stdio-bin override: child stdout → /dev/null so build
  // output cannot contaminate the parent's JSON-RPC framing; stderr stays
  // visible so build diagnostics surface.
  const mcpStdio: SpawnSyncOptions["stdio"] = ["ignore", "inherit", "inherit"];
  let observedStdio: SpawnSyncOptions["stdio"] | undefined;

  try {
    const deps: BinWrapperDeps = {
      spawnSync: (_command, _args, options) => {
        observedStdio = options.stdio;
        fx.writeEntry(entrySource);
        return fakeSpawnResult(0);
      },
      exit: defaultBinWrapperDeps.exit,
    };
    await runBinWrapperWithDeps(makeOptions(fx, { buildStdio: mcpStdio }), deps);

    assert.deepEqual(observedStdio, mcpStdio, "buildStdio must reach spawnSync's stdio option unchanged");
    assert.equal(existsSync(flagFile), true);
  } finally {
    fx.cleanup();
  }
});

test("custom buildTimeoutMs and logPrefix propagate end-to-end", async () => {
  const fx = makeFixture();
  const { captured, restore } = captureConsoleError();

  try {
    let spawnTimeout: unknown;
    let thrown: unknown;
    try {
      const deps: BinWrapperDeps = {
        spawnSync: (_command, _args, options) => {
          spawnTimeout = options.timeout;
          // Force the build-failed branch so the diagnostic fires with the custom prefix.
          return fakeSpawnResult(3);
        },
        exit: exitStub,
      };
      await runBinWrapperWithDeps(makeOptions(fx, { buildTimeoutMs: 1500, logPrefix: "custom-prefix" }), deps);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof ExitInvoked, `expected ExitInvoked, got ${thrown}`);
    assert.equal((thrown as ExitInvoked).code, 3);
    assert.equal(spawnTimeout, 1500, "buildTimeoutMs must propagate to spawnSync's timeout option");
    assert.equal(captured.length, 1);
    assert.match(captured[0] ?? "", /\[custom-prefix\] Failed to build/);
    assert.doesNotMatch(captured[0] ?? "", /\[bridgekit-bin\]/);
  } finally {
    restore();
    fx.cleanup();
  }
});

test("entry missing -> build fails non-zero -> exits with build status; logs the diagnostic", async () => {
  const fx = makeFixture();
  const { captured, restore } = captureConsoleError();

  try {
    let thrown: unknown;
    try {
      const deps: BinWrapperDeps = {
        spawnSync: () => fakeSpawnResult(2),
        exit: exitStub,
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
    restore();
    fx.cleanup();
  }
});

test("entry missing -> build exits non-zero but artifact produced -> pass-through (recovery)", async () => {
  const fx = makeFixture();
  const flagFile = join(fx.packageRoot, "ran.flag");
  const entrySource =
    `import { writeFileSync } from "node:fs";\n` +
    `export async function runServer() { writeFileSync(${JSON.stringify(flagFile)}, "ok"); }\n`;
  const { captured, restore } = captureConsoleError();

  try {
    let exitCalls = 0;
    const deps: BinWrapperDeps = {
      spawnSync: () => {
        // Simulate a build that emitted the entry but exited non-zero
        // (e.g. tsc emitted .js then reported a post-emit diagnostic).
        fx.writeEntry(entrySource);
        return fakeSpawnResult(2);
      },
      exit: (code) => {
        exitCalls += 1;
        throw new ExitInvoked(code);
      },
    };
    await runBinWrapperWithDeps(makeOptions(fx), deps);

    assert.equal(existsSync(flagFile), true, "runServer must run when the entry was produced");
    assert.equal(exitCalls, 0, "deps.exit must not be called on the recovery path");
    assert.equal(captured.length, 0, "no diagnostic must be emitted on the recovery path");
  } finally {
    restore();
    fx.cleanup();
  }
});

test("entry missing -> build exits 0 but entry still missing -> exits with code 1", async () => {
  const fx = makeFixture();
  const { captured, restore } = captureConsoleError();

  try {
    let thrown: unknown;
    try {
      const deps: BinWrapperDeps = {
        spawnSync: () => fakeSpawnResult(0),
        exit: exitStub,
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
    restore();
    fx.cleanup();
  }
});

test("entry missing -> build killed by timeout -> exits with code 1; diagnostic names the timeout", async () => {
  const fx = makeFixture();
  const { captured, restore } = captureConsoleError();

  try {
    let thrown: unknown;
    try {
      const deps: BinWrapperDeps = {
        // spawnSync timeout: status null, signal SIGTERM.
        spawnSync: () => fakeSpawnResult(null, "SIGTERM"),
        exit: exitStub,
      };
      await runBinWrapperWithDeps(makeOptions(fx, { buildTimeoutMs: 250 }), deps);
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof ExitInvoked, `expected ExitInvoked, got ${thrown}`);
    assert.equal((thrown as ExitInvoked).code, 1);
    assert.equal(captured.length, 1);
    assert.match(captured[0] ?? "", /\[bridgekit-bin\] Build timed out after 250ms/);
    assert.match(captured[0] ?? "", /signal SIGTERM/);
    assert.match(captured[0] ?? "", /Raise buildTimeoutMs/);
    assert.doesNotMatch(captured[0] ?? "", /Failed to build the local MCP server/);
  } finally {
    restore();
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
