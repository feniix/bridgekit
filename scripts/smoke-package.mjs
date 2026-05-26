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
  `;
  await run(process.execPath, ["--input-type=module", "-e", code], { cwd: installDir });
}

async function assertUnsupportedDeepImportFails(installDir) {
  const code = `
    try {
      await import("@feniix/bridgekit/dist/src/index.js");
      throw new Error("deep import unexpectedly succeeded");
    } catch (error) {
      if (error?.message === "deep import unexpectedly succeeded") throw error;
      if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
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
        type PortableDomainFailure,
        type PortableToolBuiltInHost,
        type PortableToolContext,
        type PortableToolErrorDetails,
        type PortableToolHost,
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

      const customTool = definePortableTool<typeof parameters, "custom-host">({
        name: "custom_host_tool",
        title: "Custom Host Tool",
        description: "Custom host typecheck fixture.",
        parameters,
        execute(args, ctx) {
          const customHost: "custom-host" = ctx.host;
          return { text: customHost + ":" + args.text };
        },
      });

      const builtInHost: PortableToolBuiltInHost = "mcp";
      const defaultContext: PortableToolContext = { host: builtInHost };
      const customHost: PortableToolHost<"custom-host"> = "custom-host";
      void defaultContext;
      void customHost;

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
      async function runCustom(): Promise<PortableToolResult> {
        return executePortableTool(customTool, { text: "hello" }, { host: "custom-host" });
      }
      void run;
      void runCustom;

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
          void tool;
          void validationErrors;
          void firstField;
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
