# Changelog

All notable changes to `@feniix/bridgekit` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] - 2026-07-12

### Added

- `PiHostExtras` accepts `renderCall` and `renderResult`, pi's per-tool TUI
  renderers for the call line and for the collapsed/expanded result view.
  `registerPiTools` forwards both to `pi.registerTool` by identity; the core
  never invokes them and does not import `pi-tui`. Contributed by
  [@akaGelo](https://github.com/akaGelo) in
  [#72](https://github.com/feniix/bridgekit/pull/72).

### Changed

- `docs/rfc-host-extras.md` records the renderers as Gap E, in scope as a
  registration-time pass-through.

## [0.14.0] - 2026-05-28

### Added

- `PortableTool` now carries an inferred success-result generic in addition to
  its TypeBox parameter generic. `definePortableTool` and `executePortableTool`
  preserve handler `structuredContent` types for direct/programmatic callers,
  while validation failures remain `isError: true` results that narrow with
  `isValidationFailure`.
- `runBinWrapper` now validates its string inputs before spawning or importing:
  `mcpEntry` rejects absolute paths, `..` path segments, and NUL bytes;
  `buildScript` rejects option-shaped or shell-shaped script names.
- CI and release checks now run `npm audit --omit=dev --audit-level=high`, and
  Dependabot is configured for npm and GitHub Actions updates.

### Changed

- TypeScript is now strict-plus: `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` are enabled in addition to `strict`. The packed
  consumer smoke test compiles installed declarations with the same flags.
- The Release workflow is manual-only (`workflow_dispatch`) with a `main`
  branch guard; publishing no longer happens automatically after CI on `main`.
  Third-party GitHub Actions are pinned by full commit SHA.
- Documentation now reflects the current pi default error-return behavior, the
  install-time MCP SDK dependency footprint, pre-1.0 stability/support
  expectations, and MCP stdio-safe `buildStdio` examples.

### Fixed

- `isValidationFailure` now verifies every `validationErrors[]` entry has a
  string `field` and `message` before narrowing to `PortableValidationFailure`.
- `package-lock.json` root metadata now matches `package.json#version`.

## [0.13.0] - 2026-05-27

### Added

- New `buildStdio` option on `BinWrapperOptions`
  (`@feniix/bridgekit/bin-wrapper`). Default `"inherit"` preserves
  existing behavior. **MCP stdio server bins should pass
  `["ignore", "inherit", "inherit"]`** — the build subprocess's stdout
  otherwise contaminates the parent's JSON-RPC framing on its own
  stdout. The default-`"inherit"` behavior was a latent risk for the
  two current consumers that adopted `runBinWrapper` (works today only
  because `npm run <script> --silent` happens to be quiet under tsc) and
  an active blocker for `pi-exa`, which could not migrate from its
  hand-rolled wrapper. Resolves
  [#59](https://github.com/feniix/bridgekit/issues/59).

### Changed

- `PiToolDefinition.promptGuidelines` (the internal tool-shape declared
  in `src/adapters/pi.ts` and exposed via
  `PiToolRegistration["registerTool"]`'s parameter) widened from
  `readonly string[]` to `string[]` to close a contravariance gap with
  pi-coding-agent's `ExtensionAPI`. The runtime contract is unchanged —
  `registerPiTools` has spread-copied the source array into a fresh
  `string[]` before handing it to `pi.registerTool` since 0.9.1
  (PR #48); only the type declaration catches up to reality. Consumers
  (`pi-exa`, `pi-code-reasoning`, `pi-sequential-thinking`) can drop
  the `pi as unknown as PiToolRegistration` cast at their
  `registerPiTools` call sites.
  `PortableTool.hostExtras.pi.promptGuidelines` (the consumer-facing
  metadata type) stays `readonly string[]` — that's the right contract
  for immutable consumer-owned data that bridgekit reads. Resolves
  [#60](https://github.com/feniix/bridgekit/issues/60).

## [0.12.0] - 2026-05-27

### Documentation

- `README.md` gets a full `bin-wrapper` adapter section under "API
  reference" — usage example, options breakdown, `runServer`
  contract, trusted-literal security note, and the missing-entry
  behavior matrix. Previously the subpath had a single line in the
  entrypoint table and zero body documentation. Closes the largest
  gap surfaced by the post-0.11.0 doc audit.
- `README.md` "Why" bullet and "Packaging" section updated for the
  four-entrypoint shape and the `runBinWrapper` recommendation
  (replaces the pre-0.11.0 manual checked-in-wrapper recipe).
- `llms.txt` rewrites the "Mixed source-loaded hosts and compiled
  MCP bins" section to lead with `runBinWrapper`. The 8-bullet
  manual-wrapper recipe is demoted to a fallback bullet for
  authors writing their own wrapper.
- `dist/src/bin-wrapper.d.ts` added to the published-declarations
  lists in `README.md` and `llms.txt`.
- `docs/README.md` lists `docs/rfc-host-extras.md` in the
  maintainer-docs catalog. The RFC is JSDoc-linked from
  `src/core/define-tool.ts` and was missing from the catalog.
- `src/adapters/mcp.typecheck.ts` fixes a wrong version stamp on
  the `signalFromExtra` adversarial-pin comment (was `0.10.0 (#3)`,
  should be `0.11.0 (#3)`). The pin's code is correct; only the
  comment was wrong.

No API or behavior changes.

## [0.11.0] - 2026-05-27

### Added

- New subpath export `@feniix/bridgekit/bin-wrapper` shipping
  `runBinWrapper({ metaUrl, mcpEntry, buildScript, ... })`. Eliminates
  the ~25-line "resolve dist path → spawn build if missing → import
  and run" boilerplate that mixed source-loaded pi + compiled MCP
  packages have been copy-pasting. Three downstream consumers
  (pi-sequential-thinking, pi-exa, pi-code-reasoning) carry hand-rolled
  versions today and can migrate in one-line replacements. Tested
  against four canonical scenarios (entry present; entry built on
  demand; build fails non-zero; build exits 0 with file still missing)
  plus a negative for entry modules missing the required `runServer`
  export. Resolves
  [#6](https://github.com/feniix/bridgekit/issues/6).

### Changed

- `signalFromExtra` (internal helper at `src/adapters/mcp-signal.ts`) removed.
  The MCP SDK exposes `RequestHandlerExtra<ServerRequest, ServerNotification>`
  with a guaranteed non-optional `signal: AbortSignal` field; the duck-typing
  helper existed only because the contract was undocumented. `createMcpServer`'s
  `tools/call` handler now reads `extra.signal` directly with a typed `extra`
  parameter. No behavior change; cancellation propagation is unchanged. An
  adversarial type-level pin in `src/adapters/mcp.typecheck.ts` fails closed
  if the SDK ever changes `signal`'s type. Resolves
  [#3](https://github.com/feniix/bridgekit/issues/3).

## [0.10.0] - 2026-05-27

### Removed (breaking)

- `PortableToolHost<TExtension extends string>` type alias — replaced by the
  fixed `PortableToolBuiltInHost = "pi" | "mcp" | "test"` union.
- `<THost extends string>` generic parameter on `PortableTool`,
  `PortableToolContext`, `definePortableTool`, `executePortableTool`, and
  `validatePortableToolArgs`. Host is now a fixed literal union; adapters
  outside `"pi" | "mcp"` should cast at their adapter boundary instead of
  extending the type union.

  Migration: drop the second generic argument from any of those types.
  `PortableTool<typeof params, "custom">` becomes `PortableTool<typeof params>`.
  `PortableToolContext<"custom">` becomes `PortableToolContext` (cast `host`
  at the consumer if a custom literal is needed).

  Cast pattern (custom literal at the adapter boundary):

  ```ts
  // PortableToolContext.host is fixed to PortableToolBuiltInHost.
  // A direct `as "custom-runtime"` fails under strict (TS2352 — no overlap);
  // cast through `unknown` instead.
  const ctx: PortableToolContext = {
    host: "custom-runtime" as unknown as PortableToolBuiltInHost,
  };
  ```

  Caveat: the cast lies at the type-system boundary, so
  `switch (ctx.host) { ... default: assertNever(ctx.host); }` patterns will
  fall through on the custom literal at runtime. For custom dispatch, carry
  the host identifier on an adapter-owned field rather than on `ctx.host`,
  or do a runtime allowlist check before exhaustive narrowing.

  No consumer in tree or in the three known downstream consumers
  (pi-sequential-thinking, pi-exa, pi-code-reasoning) used the generic.
  Resolves [#5](https://github.com/feniix/bridgekit/issues/5).

## [0.9.5] - 2026-05-27

### Documentation

- README restructured to quickstart-first ordering: a copy-pasteable
  three-file working example (`tools.ts`, `mcp-server.ts`,
  `pi-extension.ts`) now lands above the fold; runtime requirements,
  the import map, best practices, packaging, and the coding-agent
  section all move below. Content preserved; no new entrypoints, no
  API changes, no behavioral effects. Resolves
  [#19](https://github.com/feniix/bridgekit/issues/19).
- `docs/packaging-invariants.md` adds a cross-reference under
  `inv-mcp-sdk-major` pointing at `toInputSchema`'s JSDoc in
  `src/adapters/mcp.ts` as the canonical record of the SDK-v1
  `inputSchema.type` Zod-validation quirk that the `allOf` →
  `type: "object"` synthesis addresses. Resolves
  [#45](https://github.com/feniix/bridgekit/issues/45).

## [0.9.4] - 2026-05-27

### Fixed

- `isObjectSchema` now short-circuits on `$ref` before checking
  `type === "object"`, closing a hole where a hybrid `{type: "object", $ref:
  "..."}` schema would bypass the construction-time `$ref` rejection
  introduced in 0.9.3. The hybrid shape is not produced by TypeBox today;
  the fix guards against future schema producers (including hand-crafted
  JSON Schema). Existing `Type.Object` (no `$ref`), `Type.Cyclic` (`$ref`
  without `type`), and `Type.Intersect` (`allOf` at root, no `$ref`)
  behavior is unchanged. Resolves [#51](https://github.com/feniix/bridgekit/issues/51).

## [0.9.3] - 2026-05-27

### Fixed

- `createMcpServer` construction errors now recognize top-level `$ref` /
  `Type.Cyclic` / `Type.Recursive` schemas as a distinct rejection class with
  `$ref`-specific guidance (inline the referenced shape or split recursive
  shapes into multiple non-recursive tools), instead of falling through to
  the misdirecting "wrap with `Type.Object`" recipe. New stable error code
  `BRIDGEKIT_MCP_REF_PARAMETERS` for consumer branching. Existing
  `BRIDGEKIT_MCP_NON_OBJECT_PARAMETERS` and `BRIDGEKIT_MCP_DUPLICATE_TOOL_NAME`
  codes are unchanged. Resolves [#44](https://github.com/feniix/bridgekit/issues/44).

## [0.9.2] - 2026-05-26

### Fixed

- `PortableValidationError.field` now disambiguates slash-named properties
  (`"a/b": Type.String()`) from nested-object paths (`a: Type.Object({ b: ... })`)
  that produce identical `instancePath` values. The field-derivation walker
  reads `error.schemaPath` instead, which carries explicit `/properties/`
  markers per nesting level. Behavior change limited to the overlapping-prefix
  case from PR #42's adversarial review; the common slash-named-property case
  from 0.8.3 and the `Type.Intersect` `allOf` descent from 0.9.0 are unchanged.
  The walker treats `anyOf` and `oneOf` as branch-descent commands (parallel
  to the 0.9.0 `allOf` handler), so slash-named properties holding
  `Type.Union(...)` values preserve their prefix through per-branch errors.
  Pre-fix, the walker would match the slash-name at the `properties` level,
  then bail on `anyOf` with no handler, and the fallback would strip the
  prefix to the trailing segment. The walker now handles all three
  JSON-Schema combinators (`allOf`, `anyOf`, `oneOf`) symmetrically.
  Resolves [#43](https://github.com/feniix/bridgekit/issues/43).

## [0.9.1] - 2026-05-26

### Fixed

- pi adapter now spreads `hostExtras.pi.promptGuidelines` into a fresh
  `string[]` before handing it to `pi.registerTool`. Bridgekit's declared type
  stays `readonly string[]` (signals immutability of consumer-owned metadata),
  but the boundary copy satisfies pi-coding-agent's mutable `string[]`
  contract. Resolves contravariance friction observed in three downstream
  consumers that previously needed `pi as unknown as PiToolRegistration`
  casts. Resolves [#47](https://github.com/feniix/bridgekit/issues/47).

## [0.9.0] - 2026-05-26

### Changed

- Widened `createMcpServer` / `runMcpStdioServer` `tools` parameter from
  `PortableTool<TObject>[]` to `PortableTool<TSchema>[]`. `Type.Intersect([
  Type.Object(...), Type.Object(...)])` is now accepted alongside
  `Type.Object(...)`. Schemas that don't resolve to a JSON-Schema object at the
  top level throw at server construction with a named-tool error message
  pointing to the actionable wrapping recipe. On the wire, `tools/list`
  synthesises `type: "object"` on schemas whose top-level lowering is `allOf`
  so MCP SDK clients that Zod-validate `inputSchema.type` continue to accept
  them; existing `Type.Object` consumers see no change in payload shape.
  Resolves [#29](https://github.com/feniix/bridgekit/issues/29).
- `createMcpServer` construction error now appends Union-specific guidance
  when the offending tool's parameters lower to `anyOf`/`oneOf`, including
  when the Union is nested inside an `allOf` branch (the `Type.Intersect`
  recipe is wrong for that shape). The bare allOf-with-mixed-branches case
  now names the first non-object branch by index in the `type="..."` label
  instead of the misdirecting `type="allOf"`.
- `tools/list` payload is now pre-computed at `createMcpServer` construction
  rather than per-request. The outer `tools` array is snapshotted at that
  point: pushing or removing entries from the caller's array post-construction
  does not affect listing or dispatch. Schemas inside each tool remain held
  by reference; treat `tool.parameters` as immutable once the server is
  constructed.
- `createMcpServer` construction errors now carry a stable `error.code` so
  consumers have a non-string anchor for branching: `"BRIDGEKIT_MCP_NON_OBJECT_PARAMETERS"`
  for the top-level-object guard, `"BRIDGEKIT_MCP_DUPLICATE_TOOL_NAME"` for
  the new duplicate-name guard. Message text remains recipe-shaped for
  human reading but is not a public contract; branch on `.code`.

### Added

- `PortableTool.hostExtras` — optional per-host metadata namespace for
  host-specific fields without polluting the host-neutral tool definition.
  `hostExtras.pi` carries `pendingMessage` (fires a pre-execute `onUpdate`
  so pi-side tools can surface a "Processing..." signal without bypassing
  `registerPiTools`), `promptSnippet`, and `promptGuidelines` (passed
  through to the pi host's `registerTool` call). `hostExtras.mcp.annotations`
  (`title` / `readOnlyHint` / `destructiveHint` / `idempotentHint` /
  `openWorldHint`) is consumed in this release: annotations are attached to
  `tools/list` entries, closing the RFC §4 30-day rollback gate in the same
  release that declares the namespace rather than deferring to 0.9.x. Tools
  that don't set `hostExtras` see zero behavior change: the pi registration
  payload's key set is byte-identical to 0.8.x and the MCP `Tool` entry omits
  the `annotations` field entirely. The shape is module-augmentable: a
  custom-host adapter can extend `PortableToolHostExtras` via
  `declare module "@feniix/bridgekit"` to claim its own namespace. Resolves
  [#28](https://github.com/feniix/bridgekit/issues/28).
- `createMcpServer` now rejects duplicate tool names at construction with
  a tool-attributed error (code `BRIDGEKIT_MCP_DUPLICATE_TOOL_NAME`). The
  previous behavior silently overwrote earlier registrations in the dispatch
  map while still listing both on `tools/list`, leaving the earlier tool
  unreachable on `tools/call`.
- RFC: `docs/rfc-host-extras.md` (design doc for [#28](https://github.com/feniix/bridgekit/issues/28); no code change).

### Fixed

- `PortableValidationError.field` preservation for slash-named properties
  (the 0.8.3 fix) now descends into `Type.Intersect` (`allOf`) branches.
  Previously a property named `a/b` inside an Intersect branch resolved as
  `b` because the schema walker stopped at the root's missing `properties`
  field; the walker now probes each `allOf` branch with the full remaining
  path.

## [0.8.3] - 2026-05-26

### Fixed

- `PortableValidationError.field` now preserves the full property name when
  it contains `/`. TypeBox does not implement JSON Pointer RFC 6901's `~1`
  escape, so a property named `a/b` previously produced `field: "b"` for
  wrong-type / `const` / `enum` errors (the string-split fallback dropped
  the prefix). The fix walks the actual schema with a greedy longest-prefix
  match against `properties` keys and falls back to the prior behavior for
  paths the schema doesn't model. The `required` and `additionalProperties`
  paths were already correct via structured `params` and are unchanged.
  Resolves [#36](https://github.com/feniix/bridgekit/issues/36).

## [0.8.2] - 2026-05-26

### Fixed

- Discriminated unions now surface the active branch's
  `required`/`additionalProperties` hints. When an `anyOf` fires at a path
  and exactly one branch's discriminator (`Literal`/`const`/`enum`/`Union of
  Literals`) is satisfied by the input, BridgeKit keeps that branch's
  sibling errors and suppresses the others. For non-discriminated unions
  and ambiguous cases, the conservative "suppress all" behavior from 0.8.1
  is preserved. Resolves
  [#38](https://github.com/feniix/bridgekit/issues/38).

  Behavior notes for consumers upgrading from 0.8.1:

  - `validationErrors.length` for a discriminated-union failure now reflects
    the active branch's missing/extra props (typically 1 per missing field),
    rather than the single `{ field: "(root)", message: ".*anyOf.*" }` entry
    that 0.8.1 produced. Consumers asserting `validationErrors.length === 1`
    or checking for `field === "(root)"` on these payloads will need to
    update; assertions on `field` / `message` for the actual missing prop
    are the new contract.
  - The `anyOf`/`oneOf` summary at the union path is **suppressed** when an
    active branch is resolved. Consumers using `field: "(root)"` as a
    "union failed" sentinel will not see it for discriminated cases — read
    the active-branch's specific entry instead. The summary is still
    emitted in the fallback case (no active branch).
  - Discriminators expressed as `Type.Union([Type.Literal("a"),
    Type.Literal("b")])` (the anyOf-of-const idiom) are now recognized as
    discriminators. 0.8.1 silently treated them as non-discriminators and
    fell back to suppress-all.
  - Discriminated unions inside `Type.Array(...)` are now resolved per
    array element (the path walker descends into `items`). 0.8.1 bailed out
    on array index segments.
  - `const` / `enum` error messages now surface the allowed value(s)
    (`must equal "create"` / `must equal one of "create", "update"`)
    instead of the opaque `must be equal to constant`. Helps agents pick a
    valid discriminator value on retry.
  - Discriminator key lookup uses `Object.hasOwn`, so a schema discriminator
    whose name happens to be `toString` / `constructor` / etc. won't be
    matched via the prototype chain.

  Note on nested unions: `field` is the leaf segment of the JSON pointer
  (`"name"` for `/event/name`), not the full path. For schemas with the
  same prop name at multiple depths this can be ambiguous; consumers
  needing full path context should track which tool input branch was
  active out-of-band.

## [0.8.1] - 2026-05-26

### Fixed

- Union-of-objects validation no longer surfaces phantom missing-required-
  property entries for every branch. When TypeBox emits an `anyOf`/`oneOf`
  error at a path, sibling `required`/`additionalProperties` entries at the
  same path are now suppressed so consumers see only the union summary.
  `const`/`enum` discriminator errors at deeper paths are kept (they're
  signal about which branch was intended).
  Resolves [#35](https://github.com/feniix/bridgekit/issues/35).

## [0.8.0] - 2026-05-26

### Breaking

- **`PortableValidationError` renamed `path` → `field`.** No deprecation alias.
  Update assertions accordingly. `field` is derived from TypeBox's structured
  error data, not the localized message string. Resolves
  [#33](https://github.com/feniix/bridgekit/issues/33).

  ```ts
  // Before (0.7 and earlier)
  assert.equal(result.structuredContent.validationErrors[0].path, "/file_path");

  // After (0.8+)
  assert.equal(result.structuredContent.validationErrors[0].field, "file_path");
  ```

  Entries *inside* `validationErrors[]` share the `{ field, message }` shape
  with handler-emitted domain-failure data so iteration code can read `.field`
  uniformly. The `validationErrors[]` array itself only exists on the
  `kind: "validation"` branch of `PortableToolErrorDetails` — always narrow
  with `isValidationFailure` (or the discriminator) before iterating.

- **`validationErrors[]` cardinality change.** Previously, a TypeBox error
  with the message `must have required properties X, Y` produced a single
  `PortableValidationError` whose message listed all missing props. Now,
  `executePortableTool` emits **one `PortableValidationError` per missing
  property**, with `field` set to the missing prop name and `message`
  normalized to `must have required property <field>`. Consumers asserting
  `validationErrors.length === 1` for a multi-prop missing case will break.

  ```ts
  // Schema: Type.Object({ file_path: Type.String(), count: Type.Number() })
  // Args: {}

  // Before (0.7)
  // validationErrors.length === 1
  // validationErrors[0] === { path: "/", message: "must have required properties file_path, count" }

  // After (0.8+)
  // validationErrors.length === 2
  // validationErrors === [
  //   { field: "file_path", message: "must have required property file_path" },
  //   { field: "count",     message: "must have required property count"     },
  // ]
  ```

- **Duplicate `(field, message)` pairs are deduplicated.** Union/discriminator
  mismatches previously emitted multiple identical `(field, message)` entries
  (one per failed union branch); they are now collapsed. Dedup only removes
  entries — it never introduces new ones — so `validationErrors.length` can
  only decrease relative to raw TypeBox output. Consumers locking in exact
  counts on union failures may need to adjust.

### Notes on field derivation

- `field` is derived from TypeBox's structured error:
  - `keyword === "required"` reads `params.requiredProperties` and emits one
    entry per missing prop name.
  - `keyword === "additionalProperties"` reads `params.additionalProperties`
    and emits one entry per offending key name. (Previously fell back to the
    `(root)` sentinel — the offending key is now surfaced as `field`.)
  - Other errors take the last meaningful segment of `instancePath`
    (e.g. `/text` → `"text"`, `/items/0/name` → `"name"`).
- The structured-access path is locale- and message-format-independent.
- For array-element validation, `field` is the leaf segment, which can be a
  numeric index (e.g. `field: "0"`) and loses the path context. If positional
  information matters, keep schemas permissive at the BridgeKit boundary and
  validate positionally in your handler.
- For root-level schema failures with empty `instancePath` (e.g. `null` passed
  to a `Type.Object` schema), `field` is the sentinel `"(root)"` rather than
  the empty string.

## [0.7.0] - 2026-05-26

### Changed

- **`registerPiTools` now returns `isError` results by default instead of
  throwing.** The third parameter is a new `RegisterPiToolsOptions` with
  `errorHandling?: "throw" | "return"`; the default is `"return"`, mirroring
  the MCP adapter. Portable validation failures and portable `isError: true`
  results now surface as `{ content, details, isError: true }` on the pi side.
  Unexpected exceptions thrown by tool handlers are also caught in return
  mode and surfaced as `{ content: [{type:"text", text: message}], details: {}, isError: true }`,
  matching MCP. This makes the documented "pi throws, MCP returns" asymmetry
  symmetric. Resolves [#2](https://github.com/feniix/bridgekit/issues/2).
- pi success-path results now include `isError: false` explicitly so consumers
  can write `result.isError === false` symmetrically across pi and MCP.

### Added

- `isValidationFailure(result)` and `isDomainFailure(result)` type guards in
  the root entrypoint. Use them after `result.isError` to narrow between
  BridgeKit-emitted validation failures and tool-emitted domain failures.
  Resolves [#30](https://github.com/feniix/bridgekit/issues/30).
- `PortableValidationFailure` and `PortableDomainFailure` types alongside the
  guards.
- `RegisterPiToolsOptions` exported from `@feniix/bridgekit/pi`.
- A `DeprecationWarning` (code `BRIDGEKIT_PI_THROW_DEPRECATED`) is emitted
  once per process when `registerPiTools(..., { errorHandling: "throw" })`
  is invoked, so consumers see the migration signal at runtime instead of
  only in JSDoc.

### Deprecated

- `registerPiTools(..., { errorHandling: "throw" })` is retained for one
  minor-version cycle so existing pi extensions can migrate without source
  changes. It will be removed in 1.0. Only the `"throw"` *value* is
  deprecated; the `errorHandling` option itself stays. Migrate by switching
  to the default `"return"` mode and branching on `result.isError`.

### Removed

- The duplicate `PortableValidationError` re-export from `src/core/execute-tool.ts`.
  The canonical export still lives in `src/core/define-tool.ts` and is surfaced
  through `@feniix/bridgekit` unchanged.

### Migration

```ts
// Before (0.6 and earlier)
try {
  const result = await piTool.execute(toolCallId, params, signal);
} catch (err) {
  if (isPortableToolExecutionError(err)) {
    if (err.details.kind === "validation") { /* TypeBox errors */ }
    else { /* domain failure */ }
  }
}

// After (0.7+)
const result = await piTool.execute(toolCallId, params, signal);
if (result.isError) {
  if (isValidationFailure(result)) { /* result.structuredContent.validationErrors */ }
  else if (isDomainFailure(result)) { /* handler-level error */ }
}
```

### Notes on the guards

`isValidationFailure` narrows `structuredContent` to
`{ kind: "validation"; tool: string; validationErrors: PortableValidationError[] }`
because `executePortableTool` produces that exact shape on TypeBox rejection.
The guard matches on shape, not provenance: a handler that returns the same
shape on its own will also satisfy it. Keep handler-emitted error shapes
distinct from the validation discriminator if that ambiguity matters.

`isDomainFailure` narrows only to `result & { isError: true }`. It does **not**
synthesize a `kind: "domain"` discriminator on `structuredContent` because the
tool's handler chose `structuredContent` freely and BridgeKit does not rewrite
it on the wire.

#### Caveat: `kind` is not the same between modes

The two `errorHandling` modes expose the failure discriminator on different
fields and with different semantics. Branch by mode, not by reading `.kind`
across both shapes:

| Mode | Where to read | Validation failure | Handler-emitted failure |
|------|---------------|--------------------|-------------------------|
| `"return"` (default, 0.7+) | `result.structuredContent` | `{ kind: "validation", tool, validationErrors }` (BridgeKit-emitted) | Whatever the handler returned — no synthesized `kind` |
| `"throw"` (deprecated) | `(err as PortableToolExecutionError).details` | `{ kind: "validation", tool, validationErrors }` | `{ kind: "domain", ...rest }` (BridgeKit synthesizes) |

In return mode, prefer the type guards (`isValidationFailure`,
`isDomainFailure`) over reading `kind` directly. In throw mode, the
`PortableToolExecutionError.details.kind` discriminator is stable but the
whole mode is deprecated.

### Scope: where to call the guards

The guards take a `PortableToolResult` — the value `executePortableTool`
returns, or what your portable tool's own `execute` returns at the seam
between BridgeKit and a host. They are **not** designed to operate on the pi
adapter's wire object (`{ content, details, isError }`), which exposes
`details` instead of `structuredContent`. Calling the guards on a pi wire
object will always return `false`.
