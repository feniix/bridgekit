# Official MCP conformance and BridgeKit stdio (#130)

## Outcome (2026-10-07)

**Direct stdio remains blocked, not passed.** The initial investigation ran no
official scenarios. The published server harness requires an HTTP URL, while
`scripts/mcp-stdio-fixture.mjs` serves stdio. Adding an HTTP proxy or testing the
SDK's HTTP example would measure a different serving boundary, not certify
BridgeKit's dual-era stdio runner.

Neither `2025-11-25` nor `2026-07-28` has an official stdio conformance result.
The existing Node integration tests remain the automated gate. This note does
not close #130's acceptance criteria.

## Reproduction

Executed from the repository without adding a dependency or changing its lockfile:

```sh
pnpm dlx @modelcontextprotocol/conformance@0.1.16 server --help
pnpm dlx @modelcontextprotocol/conformance@0.1.16 server \
  --command "node scripts/mcp-stdio-fixture.mjs"
```

The help lists `--url <url>` as required and no stdio transport or server-command
option. The second invocation exits 1:

```text
error: required option '--url <url>' not specified
```

That is a harness invocation failure, **not** a BridgeKit protocol failure.
`--command` belongs to the harness's client-testing mode; using that mode would
test a client implementation against its server, not the BridgeKit server.

## Primary-source cross-check

The upstream conformance checkout inspected was
`c37eec888e1c6ff140af79987a40008548b7cc5f`. It is distinct from the published
`0.1.16` binary above; do not assume its newer flags exist in that release.

- [Conformance README at the inspected revision](https://github.com/modelcontextprotocol/conformance/blob/c37eec888e1c6ff140af79987a40008548b7cc5f/README.md):
  server tests use `server --url`; `client --command` launches clients. Revision
  requirement sets must be run separately to establish results for each wire era.
- [Conformance CLI source at that revision](https://github.com/modelcontextprotocol/conformance/blob/c37eec888e1c6ff140af79987a40008548b7cc5f/src/index.ts):
  the server command still requires `--url`; it has no stdio launch option.
- [TypeScript SDK conformance guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/test/conformance/README.md)
  and [server runner](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/test/conformance/scripts/run-server-conformance.sh)
  (inspected 2026-10-07): the SDK harness also starts an HTTP server and invokes
  the official suite with `--url http://localhost:<port>/mcp`. It is not an
  alternative stdio harness.

## CI and release recommendation

Keep official conformance as a **manual transport-support recheck**, not a
required CI job, until the harness can target the actual stdio serving boundary.
Continue running the existing legacy/default/auto/modern-pinned stdio tests in
CI. Passing those tests is not equivalent to passing the official suite.

When the blocker is removed:

1. Pin the conformance version and record its invocation and result artifacts.
2. Run tools and lifecycle scenarios against the fixture for both wire eras.
   Check required fixture names/behaviors before interpreting tool failures.
3. Classify failures: BridgeKit-owned contract, SDK/transport, fixture mismatch,
   or unsupported resources/prompts/tasks/HTTP/auth. Do not hide failures under
   a broad expected-failures baseline.
4. Fix BridgeKit-owned defects with focused regressions.
5. Evaluate CI only after the direct stdio invocation is repeatable; otherwise
   document a manual pre-release run with actual results.

## HTTP follow-up (2026-10-07)

After the user approved full feature delivery, BridgeKit added
`createMcpHttpHandler` (#126). Four official scenarios were run against the
actual BridgeKit HTTP handler through `scripts/mcp-http-fixture.mjs`, all passing:

| Scenario | `--spec-version` filter | Result |
| --- | --- | --- |
| `server-initialize` | `2025-11-25` | 1/1 checks passed |
| `tools-list` | `2025-11-25` | 1/1 checks passed |
| `tools-call-simple-text` | `2025-11-25` | 1/1 checks passed |
| `tools-call-error` | `2025-11-25` | 1/1 checks passed |

The original official check artifacts are aggregated in
[`mcp-http-conformance-2026-10-07.json`](mcp-http-conformance-2026-10-07.json).
These are selected HTTP scenarios, **not the full suite and not stdio
conformance**. `--spec-version` is the CLI scenario filter, not independent proof
of a pinned wire negotiation.

```sh
pnpm run build
node scripts/mcp-http-fixture.mjs # prints a loopback URL; keep running
pnpm dlx @modelcontextprotocol/conformance@0.1.16 server \
  --url <printed-url> --scenario tools-list --spec-version 2025-11-25 \
  --output-dir <results-directory>
```

Repeat for the other scenario names above. Stop the fixture after testing.
Attempts to run the three tools scenarios with `--spec-version 2026-07-28`
each exit 1 before testing: the pinned published harness rejects that version.
Its accepted values are `2025-03-26`, `2025-06-18`, `2025-11-25`, `draft`, and
`extension`. Do not silently substitute `draft` and claim dated conformance.

#130 remains open for direct stdio and modern-revision evidence. The selected
HTTP scenarios are currently a manual pre-release check; a required CI gate
should wait for an explicitly pinned harness that tests the desired revisions
and serving boundaries.
