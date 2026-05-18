#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const packageLockPath = join(repoRoot, "package-lock.json");

assert.equal(packageJson.main, "./dist/src/index.js", "package main must point at built root entrypoint");
assert.equal(packageJson.types, "./dist/src/index.d.ts", "package types must point at built root declarations");
assert.equal(packageJson.engines?.node, ">=22.19.0", "package must declare the supported Node runtime floor");
assert.equal(packageJson.sideEffects, false, "package must declare published modules as side-effect free");
assert.ok(packageJson.files?.includes("llms.txt"), "package files must include llms.txt");
assert.ok(packageJson.files?.includes("examples/README.md"), "package files must include examples/README.md");

const scripts = packageJson.scripts ?? {};
for (const [name, script] of Object.entries(scripts)) {
  assert.doesNotMatch(script, /\.\.\/\.\.\/scripts/, `script ${name} must not call monorepo scripts`);
  assert.doesNotMatch(script, /packages\/\*\/dist/, `script ${name} must not search monorepo package dist folders`);
}
assert.equal(scripts.build, "npm run clean && tsc -b tsconfig.json", "build script must be standalone");
assert.equal(scripts.test, "npm run build && node scripts/run-built-tests.mjs", "test script must be standalone");
assert.equal(scripts.prepack, "npm run build && npm run verify:dist", "prepack script must be standalone");
assert.equal(scripts["pack:dry-run"], "npm pack --dry-run --json", "pack dry-run script must be local only");
assert.equal(scripts["package-smoke"], "node scripts/smoke-package.mjs", "package smoke script must be local only");
assert.equal(scripts.release, undefined, "package must not define release automation in this phase");
assert.equal(scripts.publish, undefined, "package must not define publish automation in this phase");

const mcpRange = packageJson.dependencies?.["@modelcontextprotocol/sdk"];
assert.match(mcpRange ?? "", /\^?1\./, "BridgeKit extraction must keep MCP SDK v1 as the dependency baseline");
assert.equal(packageJson.dependencies?.typebox, "^1.1.31", "BridgeKit must keep TypeBox as a runtime dependency");

if (existsSync(packageLockPath)) {
  const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
  const resolvedMcp = packageLock.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version;
  assert.match(resolvedMcp ?? "", /^1\./, "package-lock must resolve @modelcontextprotocol/sdk to major version 1");
  const bridgekitLock = packageLock.packages?.[""];
  assert.equal(bridgekitLock?.engines?.node, ">=22.19.0", "package-lock root must preserve Node engine floor");
}

const documentationEntries = ["README.md", "llms.txt", "examples/README.md", "docs/extraction.md", "docs/releasing.md"];
for (const file of documentationEntries) {
  assert.ok(existsSync(join(repoRoot, file)), `missing BridgeKit documentation file: ${file}`);
}

const publicEntries = [
  "dist/src/index.js",
  "dist/src/index.d.ts",
  "dist/src/pi.js",
  "dist/src/pi.d.ts",
  "dist/src/mcp.js",
  "dist/src/mcp.d.ts",
];

function collectFiles(dir, predicate) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(path, predicate);
    return entry.isFile() && predicate(path) ? [path] : [];
  });
}

for (const file of publicEntries) {
  const path = join(repoRoot, file);
  assert.ok(existsSync(path), `missing BridgeKit dist file: ${file}`);
  const contents = readFileSync(path, "utf8");
  assert.doesNotMatch(contents, /registerMcpTools/, `${file} must not export registerMcpTools`);
}

for (const path of collectFiles(join(repoRoot, "dist", "src"), (file) => file.endsWith(".js"))) {
  const relativePath = relative(repoRoot, path);
  const contents = readFileSync(path, "utf8");
  assert.doesNotMatch(contents, /sourceMappingURL=/, `${relativePath} must not reference unpublished source maps`);
  assert.doesNotMatch(contents, /\.\.\/\.\.\/scripts/, `${relativePath} must not reference monorepo scripts`);
  assert.doesNotMatch(contents, /pi-experiments/, `${relativePath} must not reference pi-experiments at runtime`);
}

console.error("✓ bridgekit package metadata declares standalone entrypoints, engines, side effects, and docs");
console.error("✓ bridgekit dependency baseline remains MCP SDK v1 with TypeBox");
console.error("✓ bridgekit dist entrypoints are present");
console.error("✓ bridgekit public entries do not expose registerMcpTools");
console.error("✓ bridgekit dist JavaScript does not reference unpublished source maps or monorepo paths");
