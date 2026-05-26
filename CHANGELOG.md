# Changelog

All notable changes to `@feniix/bridgekit` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - Unreleased

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
