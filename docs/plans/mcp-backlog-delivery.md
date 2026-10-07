# MCP backlog delivery

## Approved direction (2026-10-07)

- Deliver features, not merely close issues by declaring them out of scope.
- Prefer current pi.dev 1.x and MCP contracts; pre-1.0 interface breaks are
  acceptable with migration notes.
- **Do not release 1.0.0.** No version is to be published without a separate
  request. All work stays under `Unreleased`.
- Use a pluggable, host-neutral task execution backend. A bounded in-memory
  implementation is acceptable for local use, with explicit no-restart
  guarantees. Durable production execution is consumer-owned.
- Ship a Web-standard HTTP handler factory, not a Node listener. Applications
  retain authentication, authorization, Host/Origin, CORS, TLS, and listener
  responsibilities.

## Delivery status

Changes listed as implemented are local, uncommitted, and unreleased. Do not
close GitHub issues merely because this checklist says implemented.

| Issue | Status | Evidence / next step |
| --- | --- | --- |
| #126 HTTP | Implemented locally | `createMcpHttpHandler`, real HTTP tests for legacy/modern, packed HTTP transport checks, README recipe/security ownership |
| #127 Tasks | Design approved; implementation pending | Add backend/execution primitive, revision-specific handlers, capability guards, TTL/capacity/cancellation, stdio and HTTP coverage |
| #128 Metadata | Implemented locally | `hostExtras.mcp.icons` / `_meta`, snapshots, exact absent key set, type fixtures, packed HTTP checks |
| #129 Lifecycle | Implemented locally | `Promise<McpStdioServerHandle>`, idempotent close, before-negotiation/in-flight shutdown tests, installed declarations |
| #130 Conformance | Partial, blocked for direct stdio/modern | Four passing official HTTP scenarios; published harness rejects `2026-07-28` and has no stdio invocation |
| #131 SDK v1 | Implemented locally | Retain dev dependency; error-schema rejection/workaround and recovery tests; documented rationale |
| #132 Progress | Upstream blocked | SDK issue #2580 remains open as checked 2026-10-07; do not remove caveat or use a timing workaround |
| #20 Stability | Pending | Record current policy and evidence-based gates without scheduling or publishing 1.0.0 |

## Tasks: current specification, not stale issue vocabulary

The modern Tasks extension uses `io.modelcontextprotocol/tasks` capability
negotiation, server-directed `resultType: "task"`, and
`tasks/get`, `tasks/update`, `tasks/cancel`. It removes modern tool-level
`execution.taskSupport` and the legacy `tasks/result` / `tasks/list` flow.
Task support must be projected per era, not advertised identically across eras.

The official `@modelcontextprotocol/ext-tasks` package currently offers requester
APIs and a legacy sampling/elicitation receiver, not a modern tool-call receiver
we can drop into BridgeKit.

Implementation must:

- Keep portable tool files free of MCP types.
- Ensure a returned handle can immediately be retrieved.
- Share task state across fresh HTTP request servers and discarded stdio probes.
- Detach task execution from the initiating request's cancellation signal;
  task cancellation goes through an execution-owned signal.
- Bound retained task state; define expiration and terminal-state races.
- Preserve normal request/response behavior for non-task tools/clients.
- Stop sending progress on the original token after returning a task handle.
- Distinguish domain `isError` results from JSON-RPC/runtime task failures.
- Avoid claiming restart durability for the in-memory backend.
- Do not promise interactive `input_required` support without implementing the
  necessary portable input seam and `tasks/update` semantics.

Primary references:

- [Tasks extension overview](https://modelcontextprotocol.io/extensions/tasks/overview)
- [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
- [Official extension package](https://github.com/modelcontextprotocol/ext-tasks)

## pi.dev 1.x compatibility audit

Inspected published `@earendil-works/pi-coding-agent@1.0.4` declarations.
Current tool fields not yet forwarded by BridgeKit include `renderShell`,
`exposure`, `namespace`, `annotations`, `defaultActive`, `executionMode`,
`constrainedSampling`, `prepareArguments`, and `prepareLoadout`.
Passive metadata can be namespaced under `hostExtras.pi`; behavioral hooks need
explicit seam design, especially argument preparation versus portable
validation. Add a real published-pi compile fixture rather than relying only on
handwritten approximations. This audit is evidence of gaps, not a claim of
complete pi.dev 1.x support.

## Validation checkpoint

After metadata, lifecycle, and HTTP changes: lint/typecheck, all **155 runtime
tests**, pack dry-run, package smoke (including both HTTP eras), and production
audit pass. Four selected official legacy-filtered HTTP scenarios pass; that
does not imply full-suite, modern, or stdio conformance.
