# MCP tasks (#127): wire contract

Status: proposal for review. Nothing in this document is implemented.
Part 1 of 3; see [02-execution-seam.md](02-execution-seam.md) and
`03-delivery-plan.md` (not yet written; references to part 3 below are
forward references).

This document pins down what BridgeKit would put on the wire. It exists because
the wording of #127 predates the extension and no longer matches the spec: it
asks for `execution.taskSupport`, which the modern revision removes.

## Source of truth

- [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)
  (status Final): the `io.modelcontextprotocol/tasks` extension.
- The `2025-11-25` experimental tasks utility, which the extension removes from
  core and is explicitly not wire-compatible with.
- SDK `@modelcontextprotocol/server` 2.3.1, inspected for what it already does.

Naming caveat: the SEP names the core revision it builds on `2026-06-30`;
BridgeKit's docs and SDK era are `2026-07-28`. This document uses BridgeKit's
name. Confirm they denote the same revision before implementation.

## Two eras, two different features

| | Legacy era (`2025-11-25`) | Modern era (`2026-07-28`) |
| --- | --- | --- |
| Opt-in | Client sends a `task` param on `tools/call` | Client declares `io.modelcontextprotocol/tasks` in per-request capabilities |
| Who decides | Client asks, server must comply for `taskSupport: required` | Server alone, per request |
| Tool-level flag | `execution.taskSupport` on `tools/list` | Removed |
| Methods | `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` | `tasks/get`, `tasks/update`, `tasks/cancel` |
| Result | Task handle, result via blocking `tasks/result` | `resultType: "task"`, result inline on `tasks/get` |
| Cancel | Returns task state | Ack only, eventually consistent |

The two are not interchangeable. BridgeKit must project them separately and
must never advertise one era's shape on the other.

## Proposal

### 1. Modern era only, first

Implement the modern extension. Do **not** implement the legacy experimental
utility in the first delivery.

Rationale:

- The legacy flow depends on blocking `tasks/result` and on `tasks/list`, whose
  scoping the SEP itself concludes cannot be defined without sessions.
- The SEP states a server that never elects to create a task remains fully
  compliant, so legacy clients keep working: they always get a synchronous
  `CallToolResult`, exactly as today.
- Legacy support can be added behind the same backend later without changing
  the portable seam (see part 2).

This narrows the "revision-specific handlers" wording in
`docs/plans/mcp-backlog-delivery.md`. It needs an explicit decision (open
question 1).

### 2. Capability negotiation

- Advertise `io.modelcontextprotocol/tasks` under `capabilities.extensions` in
  `server/discover` **only** when at least one registered tool opts in and a
  task backend is configured. Servers without either remain byte-identical to
  today, matching the `hostExtras` rule that unset features change no payload.
  Caveat (verified, SDK 2.3.1): `Server` holds one capability set, and the
  legacy `initialize` response returns the same `capabilities.extensions`
  entry. The SEP says the extension is not defined under `2025-11-25`, so the
  spike below must confirm this is harmless or strip it on legacy connections.
- Create a task only when the request's per-request client capabilities include
  the extension. The SEP forbids returning `CreateTaskResult` otherwise,
  regardless of earlier declarations. A client declaring only the legacy
  `tasks` capability counts as non-declaring. A **legacy-era connection**
  (`2025-11-25`, capabilities from `initialize`) always counts as
  non-declaring, even if its `initialize` capabilities happen to carry the
  extension key: the extension is undefined on that era, so a handle would be
  an unknown result shape. The era check comes before the capability check.
- A tool that cannot run synchronously and receives a non-declaring client
  returns `-32021` (Missing Required Client Capability) with
  `data.requiredCapabilities`. A tool that can run synchronously just runs
  synchronously. `-32021` exists only on the modern era; what a legacy client
  receives from such a tool is undecided (open question 5).
- `tasks/get`, `tasks/update` and `tasks/cancel` from a client that does not
  declare the extension also return `-32021` (SEP "Protocol Errors": MUST).
- The three-argument `tasks/get` / `tasks/cancel` registrations are also
  reachable on a legacy connection, where those names belong to the
  experimental utility. The handlers must era-gate and answer `-32601` there
  (legacy tasks are not served), never the modern shape.

### 3. Creating a task

- `tools/call` returns `{ resultType: "task", taskId, status: "working",
  createdAt, lastUpdatedAt, ttlMs, pollIntervalMs? }`.
- The handle must not be returned until `tasks/get` for it would resolve. The
  backend `create` is awaited before responding (SEP: strongly consistent
  creation).
- After returning the handle, stop emitting `notifications/progress` on the
  original token. The request is complete.
- Task IDs are generated by BridgeKit from a CSPRNG (at least 128 bits), never
  by the tool or the backend, because the SEP allows IDs to act as bearer
  tokens.

### 4. Polling, updating, cancelling

- `tasks/get`: pure idempotent read. Returns the status variant with `result`
  (completed), `error` (failed), or `inputRequests` (input_required).
  Unknown or expired ID returns `-32602`.
- `tasks/cancel`: ack-only empty result; signals the execution-owned abort
  signal (see part 2). Unknown ID returns `-32602`. The task may still end
  `completed`; do not promise `cancelled`.
- `tasks/update`: **not served in the first delivery.** It exists to answer
  `inputRequests`, which BridgeKit has no portable seam for. See the
  `input_required` section. Note the SEP defines it as one of the extension's
  three methods and says servers SHOULD ack or return `-32602` for unknown
  tasks, so a server advertising the extension but answering `-32601` is a
  deliberate deviation (open question 6).

### 5. Errors: the completed/failed split

This is the rule most likely to be implemented wrong:

| Execution outcome | Task status | Where it appears |
| --- | --- | --- |
| Tool returns normally | `completed` | `result` |
| Tool returns `isError: true` (domain failure) | `completed` | `result` with `isError: true` |
| Argument validation failure | `completed` | `result` with `isError: true` (already the portable contract) |
| Tool throws / adapter fault | `failed` | `error` as JSON-RPC `-32603` |
| TTL elapsed before completion | `failed` | `error`, `statusMessage` says expired |
| Cancel honoured | `cancelled` | `statusMessage` |
| Tool throws/rejects after the cancel signal fired | `cancelled` | `statusMessage` (an abort-induced rejection is not a fault) |

`failed` is reserved for JSON-RPC-level faults. Using it for `isError: true`
violates the SEP and would make portable domain errors look like protocol
faults.

### 6. `input_required` is out of scope

`input_required` and `tasks/update` require the server to send elicitation or
sampling requests through the client. BridgeKit has no portable seam for that:
`PortableToolContext` carries only `signal` and `progress`. Per the approved
plan, do not claim support until the seam exists. Consequences:

- The backend status union may include `input_required`, but BridgeKit never
  produces it.
- `tasks/update` is not registered, so it returns method-not-found.
- Revisit only if a portable elicitation/sampling primitive is designed
  separately.

### 7. Task notifications

`notifications/tasks` via `subscriptions/listen` is optional in the SEP.
Do not implement it in the first delivery; polling via `tasks/get` is
sufficient and works over stdio and sessionless HTTP. Record it as a follow-up.

### 8. HTTP routing header

On Streamable HTTP, clients set `Mcp-Name` to `params.taskId` for task methods
so intermediaries can route to the instance holding state. BridgeKit's HTTP
handler is application-owned for listener policy, so the doc requirement is:
**consumers running multiple instances must use a shared backend or
sticky routing on `Mcp-Name`.** The in-memory backend is single-process only.

## What the SDK already gives us (verified by inspection and probe, 2.3.1)

- On `tools/call`, a handler-provided non-`complete` `resultType` passes through
  the modern-era *stamp* (`EXTENDED_RESULT_TYPE_METHODS` includes `tools/call`),
  but `Server` then validates the handler result against the era's
  `CallToolResult` schema and `normalizeContentlessToolResult` injects
  `content: []` when the result has no `content` (it skips only results
  carrying `task`, `inputRequests` or `requestState`). A flat SEP-shaped
  `CreateTaskResult` therefore reaches the wire with a stray `content: []`.
  The handle must also bypass `projectCallToolResult`, which is the adapter's
  current return path. Both need a decision in part 2/3 (strip, or accept the
  extra field as harmless to a loose-object client).
- The modern (`2026-07-28`) codec registry contains no `tasks/*` method. The
  `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` entries belong only
  to the legacy registry. On a modern connection, `setRequestHandler("tasks/get",
  handler)` (two-argument form) is accepted but requests get `-32601`.
  `tasks/get` and `tasks/cancel` are routed only through the three-argument,
  custom-schema form (the SDK's `isExtensionReusedRequestMethod` carve-out);
  `tasks/update` is not a spec method at all, so it is a consumer-owned method
  with the same three-argument form. `tasks/result` and `tasks/list` already
  return `-32601` on modern, as the SEP requires.
- The SDK does not validate task result shapes and does not gate `tasks/*` on
  the client's declared capability; the `-32021` checks are BridgeKit's.
  `resultType: "complete"` is stamped on `tasks/get`/`tasks/update` results
  automatically.
- On HTTP the SDK already validates that `Mcp-Name` equals `params.taskId` for
  `tasks/get`, `tasks/update` and `tasks/cancel` (`-32020` on mismatch).
- The modern-era per-request client capabilities are readable in a handler as
  `ctx.mcpReq.envelope?.["io.modelcontextprotocol/clientCapabilities"]`
  (`CLIENT_CAPABILITIES_META_KEY`). On a legacy connection the
  `initialize`-scoped value comes from the deprecated
  `Server.getClientCapabilities()`.
- The SDK ties SEP-2663 to its `2026-07-28` codec (header table and the
  `tasks/get`/`tasks/cancel` reuse carve-out cite the SEP), which supports the
  SEP's `2026-06-30` and the SDK's `2026-07-28` being the same revision.

Spike still required before implementation (blocks part 3, phase 2): exercise
the three-argument `tasks/*` registrations through `serveStdio` as well as the
HTTP handler (the probe above used the HTTP handler only), and decide the
`content: []` and legacy-`initialize` points above.

## Open questions

1. **Legacy era:** approve "modern first, legacy never advertised" (this
   document), or require legacy experimental task support in the first
   delivery?
2. **Capability source:** resolved by inspection; see "What the SDK already
   gives us". Confirm through `serveStdio` during the spike.
3. **Naming:** likely the same revision (see above); confirm against the SEP
   revision table before implementation.
4. **Issue text:** retitle #127 to match this scope; the current text
   (`execution.taskSupport`, `tasks/list`) describes the superseded design.
5. **Legacy-era behavior for tools that cannot run synchronously:** `-32021` is
   modern-only. Define what a `2025-11-25` client receives (a tool-level
   `isError` result, or such tools are not listed on legacy connections),
   since "legacy clients keep working" only holds for synchronously-runnable
   tools.
6. **`tasks/update`:** keep it unregistered (`-32601`), or register it as an
   ack for unknown/non-outstanding keys and `-32602` for unknown tasks so the
   advertised extension has all three methods.
7. **Task creation failure and validation ordering:** state what happens when
   the backend is at capacity or `create` throws (the adapter's current
   catch-all would turn it into an `isError` tool result), and whether
   argument validation runs before creating a task so invalid calls do not
   consume task capacity or return a handle that is immediately `completed`
   with `isError: true`.
8. **Tool opt-in:** the per-tool flag is removed from the wire, but this
   document never says how a tool or the server decides to create a task;
   pin the portable opt-in (part 2) before "registered tool opts in" and
   "cannot run synchronously" can be evaluated.
