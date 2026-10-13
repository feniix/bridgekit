# MCP tasks (#127): delivery plan

Status: proposal for review. Nothing in this document is implemented.
Part 3 of 3; builds on [01-wire-contract.md](01-wire-contract.md) and
[02-execution-seam.md](02-execution-seam.md).

Constraints inherited from `docs/plans/mcp-backlog-delivery.md`: all changes
stay under `Unreleased`; do not release 1.0.0 and do not publish a version
without a separate request; pre-1.0 breaks are acceptable with migration notes
(none expected here, since tasks are additive and opt-in).

## Phases

Each phase is independently reviewable and leaves `main` green. Phases are
ordered by dependency, not size.

### Phase 0: spike and decisions (gates everything)

Output is a short note appended to `docs/research/` plus answers to the open
questions in parts 1 and 2. No production code.

Verify, against `@modelcontextprotocol/server` 2.3.1 on the modern era through
both `serveStdio` and the HTTP handler:

1. A `tasks/get` and `tasks/cancel` handler registered on the low-level `Server`
   is routed for modern-era clients, and what request/response shapes the SDK
   enforces (the SDK's built-in method tables carry the shared schemas).
2. Returning `resultType: "task"` from `tools/call` reaches the client intact
   (the stamp passes it through; confirm end to end).
3. Where per-request client capabilities
   (`io.modelcontextprotocol/clientCapabilities`) are readable inside a handler.
4. Whether `extensions` can be advertised in discovery capabilities from the
   low-level `Server`, and how a legacy-era client appears (must look
   non-declaring).
5. What auth info the request context carries on stdio versus HTTP.

If (1) or (3) fails, the wire contract in part 1 needs rework before any code.

### Phase 1: types and opt-in (no behaviour change)

- `McpHostExtras.tasks`, `McpTaskBackend`, related types, exported from `./mcp`.
- Validation at `createMcpServer` construction: reject malformed `tasks`
  declarations with tool-attributed errors, like icons.
- Type fixtures in `mcp.typecheck.ts`; no-hostExtras key-set assertion
  unchanged.
- Gate: nothing is advertised or emitted yet.

### Phase 2: in-memory backend

- `createInMemoryTaskBackend` with the state machine, TTL, capacity, and
  first-writer-wins rules from part 2.
- Pure unit tests with fake timers; no MCP wiring.

### Phase 3: modern-era wiring (stdio first)

- Capability advertisement, `tools/call` task creation, `tasks/get`,
  `tasks/cancel`, `-32021` for `required` tools, `-32602` for unknown IDs.
- Backend created once in the factory; stdio handle `close()` closes a default
  backend.
- Detached execution with the execution-owned signal; progress to
  `statusMessage`.

### Phase 4: HTTP parity and docs

- Same behaviour through `createMcpHttpHandler`, including state shared across
  per-exchange servers.
- README section: opting in, the signal/progress semantic differences, backend
  guarantees ("no restart durability"), multi-instance routing on `Mcp-Name`,
  caller-binding caveat.
- Update `docs/mcp-v2-migration.md` (the line saying implementation is pending)
  and the #127 row of `docs/plans/mcp-backlog-delivery.md`.
- Packed-consumer smoke coverage for the new exports.

### Deferred, explicitly not in this delivery

- Legacy-era `2025-11-25` experimental tasks (part 1, decision 1).
- `input_required` and `tasks/update` (needs a portable elicitation seam).
- `notifications/tasks` and `subscriptions/listen`.
- Durable backend implementations (consumer-owned).

## Test matrix

| Concern | Unit | stdio integration | HTTP integration |
| --- | --- | --- | --- |
| No `tasks` declaration: payloads byte-identical | yes | yes | yes |
| `optional` + declaring client returns handle | | yes | yes |
| `optional` + non-declaring client runs synchronously | | yes | yes |
| `required` + non-declaring client gets `-32021` | | yes | yes |
| Legacy-era client never receives a task | | yes | yes |
| Handle immediately retrievable via `tasks/get` | yes | yes | yes |
| `isError: true` result gives `completed`, not `failed` | yes | yes | |
| Thrown tool gives `failed` with `-32603` | yes | yes | |
| `tasks/cancel` aborts `ctx.signal`, acks unknown-terminal | yes | yes | yes |
| Cancel racing completion: first writer wins | yes | | |
| Initiating request cancel does not abort a detached task | | yes | yes |
| Progress after handle becomes `statusMessage`, no progress notifications | | yes | |
| TTL expiry, capacity eviction, capacity refusal | yes | | |
| State shared across discarded probe and per-exchange servers | | yes | yes |
| `close()` aborts running tasks of the default backend only | yes | yes | |
| Unknown task ID gives `-32602` | | yes | yes |

Both eras are exercised in the integration columns, consistent with how the
stdio runner is covered today (default, legacy, auto, modern-pinned).

## Documentation and release notes

- `CHANGELOG.md` under `Unreleased`: added (additive, opt-in).
- No migration notes expected. If phase 0 forces any change to existing
  behaviour, stop and revisit.
- Conformance: the official CLI still cannot drive stdio or `2026-07-28`
  (#130). Tasks do not change that; do not claim conformance for the tasks
  methods.

## Housekeeping this plan implies

- Retitle and rewrite #127 to match the modern-only scope; the current body
  describes `execution.taskSupport` and `tasks/list`, which the extension
  removes. Needs the maintainer's go-ahead before editing the issue.
- On approval of parts 1 and 2, record the decisions in
  `docs/plans/mcp-backlog-delivery.md` (replace the "design approved" row
  detail with a link to this directory).

## Risks

| Risk | Mitigation |
| --- | --- |
| SDK does not route or shape modern `tasks/*` as assumed | Phase 0 spike gates all code |
| Extension is still "incubating" and may change shape | Isolate behind `hostExtras.mcp.tasks` and one adapter module; additive only |
| Users read the in-memory backend as durable | Name and README say single-process, no restart guarantees |
| Detached work outlives shutdown | Default backend closed on handle `close()`; consumer backends documented as consumer-owned |
| Signal semantics surprise tool authors | Documented table in part 2; test pinning |
