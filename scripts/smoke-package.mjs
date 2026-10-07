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
  return process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
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
  assert.ok(filename, "pnpm pack JSON output must include filename");
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
assert.deepEqual(Object.keys(mcp).sort(), ["createMcpHttpHandler", "createMcpServer", "runMcpStdioServer"]);
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
      import { Type, type Static, type TSchema } from "typebox";
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
      import {
        createMcpHttpHandler,
        createMcpServer,
        type CreateMcpServerOptions,
        type McpStdioServerHandle,
        runMcpStdioServer,
      } from "@feniix/bridgekit/mcp";
      import type { Server } from "@modelcontextprotocol/server";
      import { runBinWrapper, type BinWrapperOptions } from "@feniix/bridgekit/bin-wrapper";

      const _binWrapperOpts: BinWrapperOptions = {
        metaUrl: "file:///x",
        mcpEntry: "dist/extensions/mcp-server.js",
        buildScript: "build:mcp",
      };
      void _binWrapperOpts;
      // 0.13.0 (#59): MCP-stdio-bin-shaped literal — buildStdio routes the
      // build subprocess's stdout to /dev/null so it cannot contaminate the
      // parent's JSON-RPC framing. Pin that BinWrapperOptions surfaces the
      // optional field through the installed declarations.
      const _binWrapperOptsMcp: BinWrapperOptions = {
        metaUrl: "file:///x",
        mcpEntry: "dist/extensions/mcp-server.js",
        buildScript: "build:mcp",
        buildStdio: ["ignore", "inherit", "inherit"],
      };
      void _binWrapperOptsMcp;
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
        outputSchema: Type.Object({ text: Type.String() }),
        execute(args) {
          const typed: Parameters = args;
          return { text: typed.text, structuredContent: { text: typed.text } };
        },
      });

      const builtInHost: PortableToolBuiltInHost = "mcp";
      // Pair valid and invalid spreads so rejection cannot be caused by lost schema presence.
      definePortableTool({ ...tool, execute: () => ({ text: "ok", structuredContent: { text: "ok" } }) });
      const annotatedTool: PortableTool<typeof parameters, PortableToolResult> = tool;
      definePortableTool(annotatedTool);
      definePortableTool<typeof parameters, PortableToolResult>(annotatedTool);
      const plainTool = definePortableTool({
        name: "plain", title: "Plain", description: "Schema-less composition", parameters,
        execute: (args) => ({ text: args.text }),
      });
      definePortableTool({ ...plainTool, title: "Retitled" });
      function decorate<P extends TSchema, R extends PortableToolResult>(value: PortableTool<P, R>) {
        return definePortableTool({ ...value, title: "Decorated" });
      }
      void decorate(plainTool);
      // @ts-expect-error installed declarations reject schema-incompatible successes
      definePortableTool({ ...tool, execute: () => ({ text: "bad", structuredContent: { text: 42 } }) });
      const defaultContext: PortableToolContext = { host: builtInHost };
      void defaultContext;

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
      const sdkServer: Server = createMcpServer(options);
      void sdkServer;
      const _stdioStartup: Promise<McpStdioServerHandle> = runMcpStdioServer(options);
      void _stdioStartup;
      const _http = createMcpHttpHandler(options, { legacy: "stateless", responseMode: "auto" });
      const _httpResponse: Promise<Response> = _http.fetch(new Request("http://localhost/mcp"));
      void _httpResponse;

      async function run(): Promise<PortableToolResult> {
        return executePortableTool(tool, { text: "hello" }, { host: "test" });
      }
      void run;

      async function runWithInferredResult(): Promise<void> {
        const result = await executePortableTool(tool, { text: "hello" }, { host: "test" });
        if (result.isError !== true) {
          const text: string = result.structuredContent.text;
          void text;
        }
      }
      void runWithInferredResult;

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
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
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

  // inv-pnpm-package-manager: pnpm-lock.yaml is the only lockfile, and the pinned
  // packageManager keeps local, CI, and Corepack/action-setup installs on one pnpm.
  assert.match(
    packageJson.packageManager ?? "",
    /^pnpm@\d+\.\d+\.\d+$/,
    "package.json#packageManager must pin an exact pnpm version",
  );
  assert.ok(existsSync(join(repoRoot, "pnpm-lock.yaml")), "pnpm-lock.yaml must be committed");
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]) {
    assert.equal(existsSync(join(repoRoot, lockfile)), false, `${lockfile} must not exist alongside pnpm-lock.yaml`);
  }

  // inv-mcp-sdk-major: low-level SDK v2 Server is part of the public contract.
  const mcpRange = packageJson.dependencies?.["@modelcontextprotocol/server"];
  assert.match(mcpRange ?? "", /^\^?2\./, "@modelcontextprotocol/server must remain pinned to v2.x");
  assert.equal(packageJson.dependencies?.["@modelcontextprotocol/sdk"], undefined, "v1 SDK must be test-only");
  assert.equal(packageJson.dependencies?.["@modelcontextprotocol/client"], undefined, "MCP client must be test-only");

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

async function assertPackedMcpProtocol(installDir) {
  await writeFile(
    join(installDir, "close.mjs"),
    `
    import { runMcpStdioServer } from "@feniix/bridgekit/mcp";
    const handle = await runMcpStdioServer({ name: "packed-close", version: "0", tools: [] });
    await Promise.all([handle.close(), handle.close()]);
    console.log("explicitly closed");
    `,
  );
  const closed = await run(process.execPath, ["close.mjs"], { cwd: installDir });
  assert.equal(closed.stdout.trim(), "explicitly closed");
  await writeFile(
    join(installDir, "server.mjs"),
    `
    import { Type } from "typebox";
    import { definePortableTool } from "@feniix/bridgekit";
    import { runMcpStdioServer } from "@feniix/bridgekit/mcp";
    await runMcpStdioServer({
      name: "packed-server", version: "0.0.0", tools: [definePortableTool({
        name: "echo", title: "Echo", description: "Echo",
        parameters: Type.Object({ text: Type.String() }),
        outputSchema: Type.Object({ text: Type.String() }),
        execute: args => ({ text: args.text, structuredContent: { text: args.text } }),
      })],
    });
    `,
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { Client } from "@modelcontextprotocol/client";
      import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
      import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
      import { createMcpHttpHandler } from "@feniix/bridgekit/mcp";
      import { definePortableTool } from "@feniix/bridgekit";
      import { Type } from "typebox";
      for (const modern of [false, true]) {
        const client = new Client({ name: "packed-client", version: "0.0.0" }, {
          versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
        });
        const transport = new StdioClientTransport({
          command: process.execPath, args: ["server.mjs"], stderr: "pipe",
        });
        try {
          await client.connect(transport);
          assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
          const list = await client.listTools();
          assert.equal(list.tools[0].outputSchema.type, "object");
          const result = await client.callTool({ name: "echo", arguments: { text: "packed" } });
          assert.deepEqual(result.structuredContent, { text: "packed" });
        } finally {
          await client.close();
          await transport.close();
        }
      }
      const handler = createMcpHttpHandler({
        name: "packed-http", version: "0.0.0",
        tools: [definePortableTool({
          name: "echo", title: "Echo", description: "Echo",
          parameters: Type.Object({ text: Type.String() }),
          outputSchema: Type.Object({ text: Type.String() }),
          hostExtras: { mcp: { icons: [{ src: "https://example.com/icon.svg" }], _meta: { category: "text" } } },
          execute: args => ({ text: args.text, structuredContent: { text: args.text } }),
        })],
      });
      try {
        for (const modern of [false, true]) {
          const client = new Client({ name: "packed-http-client", version: "0.0.0" }, {
            versionNegotiation: { mode: modern ? { pin: "2026-07-28" } : "legacy" },
          });
          const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
            fetch: (input, init) => handler.fetch(new Request(input, init)),
          });
          try {
            await client.connect(transport);
            assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
            const list = await client.listTools();
            assert.deepEqual(list.tools[0].icons, [{ src: "https://example.com/icon.svg" }]);
            assert.deepEqual(list.tools[0]._meta, { category: "text" });
            const result = await client.callTool({ name: "echo", arguments: { text: "packed-http" } });
            assert.deepEqual(result.structuredContent, { text: "packed-http" });
          } finally {
            await client.close();
            await transport.close();
          }
        }
      } finally {
        await handler.close();
      }
      `,
    ],
    { cwd: installDir },
  );
}

async function installedVersion(name) {
  const manifestPath = join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  assert.ok(
    existsSync(manifestPath),
    `${name} must be installed at the repo root (run pnpm install --frozen-lockfile)`,
  );
  const { version } = await readJson(manifestPath);
  assert.ok(version, `${name} installed manifest must declare a version`);
  return version;
}

let tempRoot;
try {
  tempRoot = await mkdtemp(join(tmpdir(), "bridgekit-package-smoke-"));
  const packDir = join(tempRoot, "pack");
  const installDir = join(tempRoot, "install");
  await mkdir(packDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  await assertManifestInvariants();

  const pack = await run("pnpm", ["pack", "--pack-destination", packDir, "--json"]);
  const { entry, tarballPath } = parsePackOutput(pack.stdout, packDir);
  assert.ok(existsSync(tarballPath), `expected BridgeKit tarball to exist: ${tarballPath}`);
  assertPackFileList(entry);

  // Pin consumer dependencies to the versions the frozen lockfile installed at the repo root.
  const typeboxVersion = await installedVersion("typebox");
  const serverVersion = await installedVersion("@modelcontextprotocol/server");
  const clientVersion = await installedVersion("@modelcontextprotocol/client");
  await writeFile(join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  // pnpm's isolated layout only exposes declared dependencies, so the consumer
  // declares every package it imports directly (including the SDK `Server` type).
  await run(
    "pnpm",
    [
      "add",
      "--ignore-scripts",
      tarballPath,
      `typebox@${typeboxVersion}`,
      `@modelcontextprotocol/server@${serverVersion}`,
      `@modelcontextprotocol/client@${clientVersion}`,
    ],
    { cwd: installDir },
  );

  await assertRuntimeExports(installDir);
  await assertTypesCompile(installDir);
  await assertUnsupportedDeepImportFails(installDir);
  await assertPackedMcpProtocol(installDir);

  console.error(
    "✓ manifest invariants (sideEffects, no release/publish scripts, pinned pnpm, MCP SDK v2 server, no source maps)",
  );
  console.error("✓ packed tarball file list includes public runtime entries and excludes tests/maps");
  console.error("✓ temporary consumer imports all public runtime subpaths from installed tarball");
  console.error("✓ temporary consumer compiles strict-plus NodeNext TypeScript against installed declarations");
  console.error("✓ unsupported deep imports fail through package exports");
  console.error("✓ packed server serves legacy and modern stdio clients with declared structured output");
} finally {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
