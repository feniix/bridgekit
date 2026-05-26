# Changelog

All notable changes to `@feniix/bridgekit` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- **`registerPiTools` now returns `isError` results by default instead of
  throwing.** The third parameter is a new `RegisterPiToolsOptions` with
  `errorHandling?: "throw" | "return"`; the default is `"return"`, mirroring
  the MCP adapter. Portable validation failures and portable `isError: true`
  results now surface as `{ content, details, isError: true }` on the pi side.
  This makes the documented "pi throws, MCP returns" asymmetry symmetric.
  Resolves [#2](https://github.com/feniix/bridgekit/issues/2).

### Added

- `isValidationFailure(result)` and `isDomainFailure(result)` type guards in
  the root entrypoint. Use them after `result.isError` to narrow between
  BridgeKit-emitted validation failures and tool-emitted domain failures.
  Resolves [#30](https://github.com/feniix/bridgekit/issues/30).
- `PortableValidationFailure` and `PortableDomainFailure` types alongside the
  guards.
- `RegisterPiToolsOptions` exported from `@feniix/bridgekit/pi`.

### Deprecated

- `registerPiTools(..., { errorHandling: "throw" })` is retained for one
  minor-version cycle so existing pi extensions can migrate without source
  changes. It will be removed in 1.0. Migrate by switching to the default
  `"return"` mode and branching on `result.isError`.

### Removed

- The duplicate `PortableValidationError` re-export from `src/core/execute-tool.ts`.
  The canonical export still lives in `src/core/define-tool.ts` and is surfaced
  through `@feniix/bridgekit` unchanged.

### Migration

```ts
// Before
try {
  await piToolResult;
} catch (err) { if (isPortableToolExecutionError(err)) { ... } }

// After
const result = await piTool.execute(...);
if (result.isError) {
  if (isValidationFailure(result)) { /* structured TypeBox errors */ }
  else if (isDomainFailure(result)) { /* handler-level error */ }
}
```

### Notes on the guards

`isValidationFailure` narrows `structuredContent` to
`{ kind: "validation"; tool: string; validationErrors: PortableValidationError[] }`
because `executePortableTool` produces that exact shape on TypeBox rejection.

`isDomainFailure` narrows only to `result & { isError: true }`. It does **not**
synthesize a `kind: "domain"` discriminator on `structuredContent` because the
tool's handler chose `structuredContent` freely and BridgeKit does not rewrite
it on the wire. (The pi adapter's deprecated `PortableToolExecutionError.details`
does synthesize `kind: "domain"` after the fact for the `"throw"` path; that is
distinct from what the guard sees on the result.)
