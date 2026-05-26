# Changelog

All notable changes to `@feniix/bridgekit` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - Unreleased

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

  After this rename, validation and domain errors share the same
  `{ field, message }` per-item shape, so consumers reading `.field` no longer
  need to branch on which kind of failure produced the entry.

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
  (one per failed union branch); they are now collapsed. Consumers locking in
  exact counts on union failures may need to adjust.

### Notes on field derivation

- `field` is derived from TypeBox's structured error: required-property errors
  read `params.requiredProperties` directly (locale- and message-format-
  independent); other errors take the last meaningful segment of
  `instancePath` (e.g. `/text` → `"text"`, `/items/0/name` → `"name"`).
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
