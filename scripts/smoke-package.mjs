#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 60_000;

function executable(command) {
  return process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
}

async function run(command, args, options = {}) {
  try {
    return await execFile(executable(command), args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
      ...options,
    });
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
    const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${stdout}${stderr}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parsePackOutput(stdout, packDir) {
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const filename = entry.filename ?? entry.name;
  assert.ok(filename, "npm pack JSON output must include filename");
  return { entry, tarballPath: resolve(packDir, basename(filename)) };
}

async function assertRuntimeExports(installDir) {
  const code = `
    import assert from "node:assert/strict";
    import * as core from "@feniix/bridgekit";
    import * as pi from "@feniix/bridgekit/pi";
    import * as mcp from "@feniix/bridgekit/mcp";
    import * as binWrapper from "@feniix/bridgekit/bin-wrapper";
    assert.deepEqual(Object.keys(core).sort(), [
      "definePortableTool",
      "executePortableTool",
      "isDomainFailure",
      "isValidationFailure",
      "validatePortableToolArgs",
    ]);
    assert.deepEqual(Object.keys(pi).sort(), ["PortableToolExecutionError", "isPortableToolExecutionError", "registerPiTools"]);
    assert.deepEqual(Object.keys(mcp).sort(), ["createMcpServer", "runMcpStdioServer"]);
    assert.equal(["register", "McpTools"].join("") in mcp, false);
    assert.deepEqual(Object.keys(binWrapper).sort(), ["runBinWrapper"]);
    assert.equal(typeof binWrapper.runBinWrapper, "function");
  `;
  await run(process.execPath, ["--input-type=module", "-e", code], { cwd: installDir });
}

async function assertUnsupportedDeepImportFails(installDir) {
  const code = `
    for (const specifier of [
      "@feniix/bridgekit/dist/src/index.js",
      "@feniix/bridgekit/dist/src/bin-wrapper.js",
      "@feniix/bridgekit/bin-wrapper-internal",
      "@feniix/bridgekit/dist/src/bin-wrapper-internal.js",
    ]) {
      try {
        await import(specifier);
        throw new Error("deep import unexpectedly succeeded: " + specifier);
      } catch (error) {
        if (error?.message?.startsWith?.("deep import unexpectedly succeeded")) throw error;
        if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      }
    }
  `;
  await run(process.execPath, ["--input-type=module", "-e", code], { cwd: installDir });
}

async function assertTypesCompile(installDir) {
  const typecheckFile = join(installDir, "bridgekit-consumer.ts");
  await writeFile(
    typecheckFile,
    `
      import { Type, type Static } from "typebox";
      import {
        definePortableTool,
        executePortableTool,
        isDomainFailure,
        isValidationFailure,
        type McpHostExtras,
        type PiHostExtras,
        type PortableDomainFailure,
        type PortableTool,
        type PortableToolBuiltInHost,
        type PortableToolContext,
        type PortableToolErrorDetails,
        type PortableToolHostExtras,
        type PortableToolResult,
        type PortableValidationFailure,
      } from "@feniix/bridgekit";
      import {
        isPortableToolExecutionError,
        PortableToolExecutionError,
        type PiToolRegistration,
        type RegisterPiToolsOptions,
        registerPiTools,
      } from "@feniix/bridgekit/pi";
      import { type CreateMcpServerOptions } from "@feniix/bridgekit/mcp";
      import { runBinWrapper, type BinWrapperOptions } from "@feniix/bridgekit/bin-wrapper";

      const _binWrapperOpts: BinWrapperOptions = {
        metaUrl: "file:///x",
        mcpEntry: "dist/extensions/mcp-server.js",
        buildScript: "build:mcp",
      };
      void _binWrapperOpts;
      void runBinWrapper;

      // Regression pin: the internal test-injection seams must never leak
      // into the published BinWrapperOptions type. If a future refactor
      // re-exposes _spawnSync / _existsSync / _exit, these @ts-expect-error
      // directives become unused and TypeScript errors here.
      // @ts-expect-error _spawnSync is not part of BinWrapperOptions.
      const _bad1: BinWrapperOptions = { metaUrl: "file:///x", mcpEntry: "y", buildScript: "z", _spawnSync: () => undefined as never };
      // @ts-expect-error _existsSync is not part of BinWrapperOptions.
      const _bad2: BinWrapperOptions = { metaUrl: "file:///x", mcpEntry: "y", buildScript: "z", _existsSync: () => true };
      // @ts-expect-error _exit is not part of BinWrapperOptions.
      const _bad3: BinWrapperOptions = { metaUrl: "file:///x", mcpEntry: "y", buildScript: "z", _exit: () => { throw new Error("x"); } };
      void _bad1; void _bad2; void _bad3;

      const parameters = Type.Object({ text: Type.String() });
      type Parameters = Static<typeof parameters>;
      const tool = definePortableTool({
        name: "typecheck_tool",
        title: "Typecheck Tool",
        description: "Typecheck fixture.",
        parameters,
        execute(args) {
          const typed: Parameters = args;
          return { text: typed.text, structuredContent: { text: typed.text } };
        },
      });

      const builtInHost: PortableToolBuiltInHost = "mcp";
      const defaultContext: PortableToolContext = { host: builtInHost };
      void defaultContext;

      // Arity pin: PortableTool carries one type parameter as of 0.10.0.
      // A future regression that re-adds <THost> (even with a default) would
      // make this line compile and the @ts-expect-error would itself error.
      // @ts-expect-error PortableTool accepts exactly one type parameter since 0.10.0.
      type _PortableToolArity = PortableTool<typeof parameters, "custom-host">;
      // Host union pin: PortableToolContext.host rejects literals outside the built-in union.
      // @ts-expect-error PortableToolContext.host is fixed to PortableToolBuiltInHost since 0.10.0.
      const _rejectedCustomCtx: PortableToolContext = { host: "custom-host" };
      void _rejectedCustomCtx;

      const options: CreateMcpServerOptions = {
        name: "typecheck-server",
        version: "0.1.0",
        tools: [tool],
      };
      const piRegistration: PiToolRegistration = {
        registerTool() {
          return undefined;
        },
      };
      void options;
      void piRegistration;

      async function run(): Promise<PortableToolResult> {
        return executePortableTool(tool, { text: "hello" }, { host: "test" });
      }
      void run;

      const error: unknown = new PortableToolExecutionError({
        text: "bad",
        structuredContent: { kind: "validation", tool: "typecheck_tool", validationErrors: [] },
        isError: true,
      });
      if (isPortableToolExecutionError(error)) {
        const details: PortableToolErrorDetails = error.details;
        if (details.kind === "validation") {
          const tool: string = details.tool;
          const validationErrors = details.validationErrors;
          // Exercise PortableValidationError.field so a regression that ships
          // .path in the published .d.ts is caught at pack time.
          const firstField: string | undefined = validationErrors[0]?.field;
          // @ts-expect-error path was removed in 0.8.0 and must not reappear on the published type.
          const legacyPath: string | undefined = validationErrors[0]?.path;
          void tool;
          void validationErrors;
          void firstField;
          void legacyPath;
        } else {
          const kind: "domain" = details.kind;
          void kind;
        }
      }

      const typed: PortableToolResult<{ output: string }> = {
        text: "hi",
        structuredContent: { output: "hi" },
      };
      const narrowedOutput: string = typed.structuredContent?.output ?? "";
      void narrowedOutput;

      // Result-guard typecheck: narrows structuredContent on validation failures.
      const sampleResult: PortableToolResult = {
        text: "bad",
        structuredContent: { kind: "validation", tool: "x", validationErrors: [] },
        isError: true,
      };
      if (isValidationFailure(sampleResult)) {
        const failure: PortableValidationFailure = sampleResult;
        const toolName: string = failure.structuredContent.tool;
        void toolName;
      } else if (isDomainFailure(sampleResult)) {
        const domain: PortableDomainFailure = sampleResult;
        const isErrored: true = domain.isError;
        void isErrored;
      }

      // RegisterPiToolsOptions wires through the third arg.
      const piRegistrationOptions: RegisterPiToolsOptions = { errorHandling: "return" };
      const piWiring: PiToolRegistration = { registerTool() { return undefined; } };
      registerPiTools(piWiring, [tool], piRegistrationOptions);

      // hostExtras: native pi + mcp shapes plus module-augmented custom host.
      // Locks the public surface of issue #28 against installed declarations.
      declare module "@feniix/bridgekit" {
        interface PortableToolHostExtras {
          "custom-runtime"?: { something: string };
        }
      }
      const piExtras: PiHostExtras = {
        pendingMessage: "Processing...",
        promptSnippet: "snippet",
        promptGuidelines: ["one", "two"],
      };
      const mcpExtras: McpHostExtras = {
        annotations: { readOnlyHint: true },
      };
      const allExtras: PortableToolHostExtras = {
        pi: piExtras,
        mcp: mcpExtras,
        "custom-runtime": { something: "x" },
      };
      const toolWithExtras = definePortableTool({
        name: "with_extras",
        title: "With Extras",
        description: "Tool that carries hostExtras.",
        parameters,
        execute(args) {
          return { text: args.text };
        },
        hostExtras: allExtras,
      });
      void toolWithExtras;
    `,
  );

  const tsc = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  await run(
    tsc,
    [
      "--noEmit",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      typecheckFile,
    ],
    { cwd: installDir },
  );
}

async function assertManifestInvariants() {
  const packageJson = await readJson(join(repoRoot, "package.json"));

  // inv-side-effects-false: bundlers tree-shake unused subpath imports only when
  // the manifest declares the package side-effect free. Silent regression on consumers.
  assert.equal(packageJson.sideEffects, false, "package.json#sideEffects must be false for tree-shaking");

  // inv-no-release-publish-scripts: BridgeKit releases through GitHub Actions
  // with OIDC trusted publishing. Local `npm publish` or a `release` script
  // would bypass provenance attestation.
  const scripts = packageJson.scripts ?? {};
  assert.equal(
    scripts.release,
    undefined,
    "package.json must not define a release script (releases go through Actions)",
  );
  assert.equal(
    scripts.publish,
    undefined,
    "package.json must not define a publish script (releases go through Actions)",
  );

  // inv-mcp-sdk-major: the MCP adapter is built on SDK v1's low-level Server
  // semantics. v2 migration is a separate ADR.
  const mcpRange = packageJson.dependencies?.["@modelcontextprotocol/sdk"];
  assert.match(mcpRange ?? "", /^\^?1\./, "@modelcontextprotocol/sdk must remain pinned to v1.x");

  // inv-no-source-map-urls: tsconfig.json declares sourceMap: false and the
  // package does not ship `.map` files. Shipping a sourceMappingURL reference
  // without the matching .map breaks debuggers downstream.
  const distDir = join(repoRoot, "dist", "src");
  for (const path of collectFiles(distDir, (file) => file.endsWith(".js"))) {
    const contents = await readFile(path, "utf8");
    assert.doesNotMatch(contents, /sourceMappingURL=/, `${path} must not reference unpublished source maps`);
  }
}

function collectFiles(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(path, predicate);
    return entry.isFile() && predicate(path) ? [path] : [];
  });
}

function assertPackFileList(entry) {
  const files = new Set((entry.files ?? []).map((file) => file.path));
  const required = [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "llms.txt",
    "examples/README.md",
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "dist/src/pi.js",
    "dist/src/pi.d.ts",
    "dist/src/mcp.js",
    "dist/src/mcp.d.ts",
    "dist/src/bin-wrapper.js",
    "dist/src/bin-wrapper.d.ts",
  ];
  for (const file of required) {
    assert.ok(files.has(file), `packed file list must include ${file}`);
  }
  for (const file of files) {
    assert.doesNotMatch(file, /\.test\./, `packed file list must exclude tests: ${file}`);
    assert.doesNotMatch(file, /\.typecheck\./, `packed file list must exclude typecheck fixtures: ${file}`);
    assert.doesNotMatch(file, /\.map$/, `packed file list must exclude source maps: ${file}`);
    assert.notEqual(file, "tsconfig.tsbuildinfo", "packed file list must exclude tsbuildinfo");
  }
}

let tempRoot;
try {
  tempRoot = await mkdtemp(join(tmpdir(), "bridgekit-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const installDir = join(tempRoot, "install");
  await mkdir(packDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  await assertManifestInvariants();

  const pack = await run("npm", ["pack", "--pack-destination", packDir, "--json"]);
  const { entry, tarballPath } = parsePackOutput(pack.stdout, packDir);
  assert.ok(existsSync(tarballPath), `expected BridgeKit tarball to exist: ${tarballPath}`);
  assertPackFileList(entry);

  const packageLock = await readJson(join(repoRoot, "package-lock.json"));
  const typeboxVersion = packageLock.packages?.["node_modules/typebox"]?.version ?? "1.1.38";
  await writeFile(
    join(installDir, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: { typebox: typeboxVersion } }, null, 2),
  );
  await run("npm", ["install", "--ignore-scripts", tarballPath, `typebox@${typeboxVersion}`], { cwd: installDir });

  await assertRuntimeExports(installDir);
  await assertTypesCompile(installDir);
  await assertUnsupportedDeepImportFails(installDir);

  console.error("✓ manifest invariants (sideEffects, no release/publish scripts, MCP SDK v1, no source maps)");
  console.error("✓ packed tarball file list includes public runtime entries and excludes tests/maps");
  console.error("✓ temporary consumer imports all public runtime subpaths from installed tarball");
  console.error("✓ temporary consumer compiles NodeNext TypeScript against installed declarations");
  console.error("✓ unsupported deep imports fail through package exports");
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
