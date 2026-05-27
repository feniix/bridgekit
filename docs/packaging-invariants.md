# Packaging invariants

This document is the catalog of assertions enforced by `scripts/smoke-package.mjs`. Each check has its own section with a stable anchor (`inv-*`) so PRs that touch the verification pipeline can link directly to the rationale.

> **Adding or removing a check?** Update this file in the same PR. Drift between the catalog and the script is the failure mode this document exists to prevent.

## Why this catalog exists

`scripts/smoke-package.mjs` is the single source of truth for "is the published artifact correct?" It packs the tarball, installs it into a temp consumer, and exercises the runtime, type, and packaging contracts. The script is small but each assertion guards a specific failure mode that's invisible in normal development. A future maintainer touching the pipeline needs to know which checks are load-bearing and which can be dropped.

This catalog originally backed two scripts: `verify-bridgekit-dist.mjs` (manifest + dist-on-disk checks at prepack) and `smoke-package.mjs` (pack + install + exercise). Analysis showed `verify-dist`'s checks were either redundant with smoke (if the manifest is broken, the smoke install fails) or weak signal (extraction-era ceremony). The four genuinely load-bearing assertions from `verify-dist` were folded into smoke, the script was deleted, and the `verify:dist` npm script was removed. This document covers only what remained.

## inv-side-effects-false

**Assertion**: `package.json#sideEffects === false`.

**Where**: `scripts/smoke-package.mjs:assertManifestInvariants`.

**Failure mode**: A consumer's bundler can't tree-shake bridgekit. Unused subpath imports drag in the MCP SDK or pi adapter code anyway. No runtime failure — purely a silent perf regression invisible to bridgekit's own tests.

**Motivation**: The four-entrypoint split (`.`, `./pi`, `./mcp`, `./bin-wrapper`) is performance-load-bearing for consumers; `sideEffects: false` is the second half of the contract that makes the split work. No other check catches this.

**Removable?** No.

---

## inv-no-release-publish-scripts

**Assertion**: `package.json#scripts` defines neither `release` nor `publish`.

**Where**: `scripts/smoke-package.mjs:assertManifestInvariants`.

**Failure mode**: Someone adds `"publish": "npm publish"` or a custom release script. A maintainer runs `npm run publish` locally, bypassing the GitHub Actions OIDC release flow. The published artifact has no provenance attestation, and any future supply-chain audit will flag the version as un-attested.

**Motivation**: Releases must go through `.github/workflows/release.yml` so OIDC mints a short-lived publish credential and `--provenance` attaches a signed attestation. `npm publish` from a developer machine produces an artifact that *looks* legitimate but isn't signed. See `docs/releasing.md#trusted-publishing-and-provenance`.

**Removable?** No while OIDC trusted publishing is the release contract.

---

## inv-mcp-sdk-major

**Assertion**: `@modelcontextprotocol/sdk` is range-pinned to `^1.x` in `dependencies`.

**Where**: `scripts/smoke-package.mjs:assertManifestInvariants`.

**Failure mode**: A version bump to v2.x ships. The MCP adapter is built on the SDK's low-level `Server` with explicit `ListToolsRequestSchema` / `CallToolRequestSchema` handlers — v2 may change those request schemas, the `Tool` type shape, or the `extra` cancellation surface. The adapter would compile but misbehave at runtime against v2.

**Motivation**: v2 migration is a separate decision documented in `docs/releasing.md#mcp-sdk-stance`. Catching this at the manifest level (rather than waiting for the runtime to break) keeps PR review focused.

**Related v1 quirks to revisit on v2 bump**:

- `tools/list` synthesizes `type: "object"` on schemas whose top-level lowering is `allOf` (e.g., `Type.Intersect`-rooted tools). See `toInputSchema`'s JSDoc in `src/adapters/mcp.ts` for the canonical record. The synthesis exists because the MCP SDK v1 client Zod-validates `inputSchema.type === "object"`; if SDK v2 relaxes or moves that check, this synthesis can be removed.

**Removable?** Only when an explicit v2 migration ratifies the SDK bump.

---

## inv-no-source-map-urls

**Assertion**: No `dist/src/**/*.js` file contains a `sourceMappingURL=` reference.

**Where**: `scripts/smoke-package.mjs:assertManifestInvariants`.

**Failure mode**: tsconfig sets `sourceMap: true` (perhaps for local debugging) but the `.map` files are excluded from the tarball via `package.json#files`. Consumers see broken sourcemap warnings or fail to attach a debugger to bridgekit code.

**Motivation**: `tsconfig.json` declares `sourceMap: false` and the `files` list excludes `*.map`. This check enforces the matching dist invariant — catches the bug where tsconfig drifts and emits maps without them being packed.

**Removable?** Only by deciding to ship sourcemaps, which would also require updating `package.json#files`.

---

## inv-pack-file-list-shape

**Assertion**: The packed tarball file list includes every required public entry (`package.json`, `README.md`, `llms.txt`, `examples/README.md`, the eight `dist/src/{index,pi,mcp,bin-wrapper}.{js,d.ts}` files) and excludes `*.test.*`, `*.typecheck.*`, `*.map`, `tsconfig.tsbuildinfo`. The internal `dist/src/bin-wrapper-internal.{js,d.ts}` ships in the tarball (the public `bin-wrapper.js` imports from it at runtime) but is not reachable through `package.json#exports`; see `inv-deep-imports-fail` below.

**Where**: `scripts/smoke-package.mjs:assertPackFileList`.

**Failure mode**: A new test file pattern slips past `package.json#files` excludes and ships in the tarball. Or a public entry goes missing because a tsconfig change broke the output layout.

**Motivation**: `package.json#files` is allowlist-shaped, but the test files live *inside* `dist/`, so they need explicit excludes. A missed exclude is invisible without a dedicated check.

**Removable?** No.

---

## inv-public-export-keys

**Assertion**: After installing the tarball into a temp consumer, the runtime keys of each subpath import match the documented surface exactly:

- `@feniix/bridgekit`: `["definePortableTool", "executePortableTool", "isDomainFailure", "isValidationFailure", "validatePortableToolArgs"]`
- `@feniix/bridgekit/pi`: `["PortableToolExecutionError", "isPortableToolExecutionError", "registerPiTools"]`
- `@feniix/bridgekit/mcp`: `["createMcpServer", "runMcpStdioServer"]`
- `@feniix/bridgekit/bin-wrapper`: `["runBinWrapper"]` (also: `typeof runBinWrapper === "function"`)

**Where**: `scripts/smoke-package.mjs:assertRuntimeExports`.

**Failure mode**: A new public function is exported (or removed) without being documented. The smoke test enforces that the *runtime* surface matches expectations rather than relying on the source tree being authoritative.

**Motivation**: TypeScript's `export` keyword affects both types and runtime; the latter is invisible without a runtime check. Re-exports through barrels can also surface unintended keys.

**Removable?** No.

---

## inv-no-register-mcp-tools

**Assertion**: The `@feniix/bridgekit/mcp` subpath does not export a `registerMcpTools` member.

**Where**: Two enforcement layers:

- `scripts/smoke-package.mjs:assertRuntimeExports` — runtime key check on the installed tarball (`"registerMcpTools" in mcp === false`, computed via `["register", "McpTools"].join("")` so the assertion text doesn't false-positive against itself in a future grep).
- `src/adapters/mcp.test.ts:10` — compile-time surface assertion on the source `*` import.

**Failure mode**: Someone re-introduces a high-level MCP helper because it "feels missing" from the API. The bridgekit MCP adapter is intentionally built on the low-level `Server` so TypeBox schemas pass through as `inputSchema` without JSON Schema conversion. A high-level helper would silently introduce a converter.

**Motivation**: Defense in depth across two distinct mechanisms (post-install runtime keys; pre-build compile surface). A change that survives one usually doesn't survive the other.

**Removable?** Only if there's a deliberate decision to expose a high-level wrapper, validated against the installed SDK.

---

## inv-deep-imports-fail

**Assertion**: From an installed consumer, the following deep imports all fail (either `ERR_PACKAGE_PATH_NOT_EXPORTED` or `ERR_MODULE_NOT_FOUND` — exports-map rejection or unresolvable subpath):

- `@feniix/bridgekit/dist/src/index.js`
- `@feniix/bridgekit/dist/src/bin-wrapper.js`
- `@feniix/bridgekit/bin-wrapper-internal`
- `@feniix/bridgekit/dist/src/bin-wrapper-internal.js`

The last two pin that the internal module backing `runBinWrapper` is unreachable through any deep import even though it ships in the tarball.

**Where**: `scripts/smoke-package.mjs:assertUnsupportedDeepImportFails`.

**Failure mode**: The `exports` map widens (a wildcard, a forgotten directory) and consumers start deep-importing — which removes bridgekit's ability to refactor `dist/` layout without a major version bump.

**Motivation**: The four-entrypoint discipline (`.`, `./pi`, `./mcp`, `./bin-wrapper`) is the single most important shape of the package surface. This check proves that arbitrary `dist/` paths are *actively rejected*, not merely undocumented.

**Removable?** No.

---

## inv-types-strict-compile

**Assertion**: A NodeNext TypeScript fixture against the installed declarations compiles strict-clean.

**Where**: `scripts/smoke-package.mjs:assertTypesCompile`.

**Failure mode**: A change to a generic or a re-export breaks downstream `.d.ts` consumption. Pure runtime tests can't catch this — the fixture must compile against the *installed* declarations to expose moduleResolution-level issues.

**Motivation**: The published `.d.ts` files are the canonical type contract. Anything that source-builds cleanly but breaks on consumption is a packaging bug, not a logic bug.

**Removable?** No.
