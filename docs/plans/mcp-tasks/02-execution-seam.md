# MCP tasks (#127): execution seam

Status: proposal for review. Nothing in this document is implemented.
Part 2 of 3; builds on [01-wire-contract.md](01-wire-contract.md). Continues in
[03-delivery-plan.md](03-delivery-plan.md).

This document answers #127's acceptance question: how a portable tool opts into
task semantics without leaking MCP types into tool files, and what execution
primitive sits behind that.

## Headline proposal: no new core primitive

#127 guessed "`hostExtras.mcp` plus a core execution primitive". Reading the
current seams suggests the core primitive is unnecessary:

- A portable tool is already `execute(args, ctx) => result | Promise<result>`
  with `ctx.signal` and `ctx.progress`. Nothing about that function says how
  long it runs or who is waiting on it.
- Whether a call is synchronous or detached is a property of the **adapter and
  backend**, not of the tool. The same `execute` can be awaited inline or run
  detached and polled.
- So tasks become an MCP-adapter concern. No new core *primitive* is added and
  `src/adapters/pi.ts` stays untouched. The only core change is the additive
  `tasks?` member on the `McpHostExtras` type in `src/core/define-tool.ts`
  (where the existing `icons`/`_meta`/`annotations` live). A tool needs no code
  change to be task-capable, only a declaration that it may be.

This keeps the layering rule intact (tool files host-neutral; host wiring in the
adapter) and avoids committing the portable contract to a polling model before
a second host needs it.

## Opt-in: `hostExtras.mcp.tasks`

Add one namespaced field, following the admission rules in
[`docs/rfc-host-extras.md`](../../rfc-host-extras.md):

```ts
interface McpHostExtras {
  // existing: icons, _meta, annotations
  tasks?: {
    /**
     * "optional": run as a task when the client negotiated the extension,
     *             otherwise run synchronously (today's behaviour).
     * "required": the tool cannot reasonably run inline. A client that has not
     *             negotiated the extension receives -32021.
     */
    support: "optional" | "required";
    /** Suggested retention. `null` = unlimited. Defaults to the backend's. */
    ttlMs?: number | null;
    /** Suggested client polling interval. */
    pollIntervalMs?: number;
  };
}
```

Rules, matching the existing `hostExtras` conventions:

- Read path gates on `!== undefined`; tools without it produce byte-identical
  `tools/list` and `tools/call` payloads. Pin with the existing no-hostExtras
  key-set assertion.
- Copied at server construction, like `annotations`.
- Emits **nothing** into `tools/list`. The modern revision removes
  `execution.taskSupport`, so there is no wire field to project. (Contrast with
  the stale wording in #127.)
- Pi ignores the namespace.

## What changes for the tool author

Nothing in the function signature. Two documented semantic differences when a
call runs as a task:

| Context field | Synchronous call (today) | Task call |
| --- | --- | --- |
| `ctx.signal` | Aborts when the client cancels the request or the transport closes | Aborts on `tasks/cancel`, TTL expiry, or backend close (default backend closed by the stdio handle). Closing a per-exchange or per-probe SDK server does **not** abort it. **Not** tied to the initiating request |
| `ctx.progress` | `notifications/progress` on the request's token | Updates the task's `statusMessage`; no progress notifications are sent after the handle is returned |

The first row is the load-bearing one: the initiating `tools/call` has already
returned its handle, so its signal can no longer govern the work. The plan's
"execution-owned signal" requirement is exactly this.

`isError: true` results and argument-validation failures need no new handling:
`executePortableTool` already returns them as results, which map to a
`completed` task (see part 1, section 5).

## Backend interface

Tasks need state that outlives one request. Stdio probe servers are discarded
after negotiation and the HTTP handler creates a fresh SDK server per exchange,
so state cannot live on the SDK `Server`.

```ts
interface McpTaskBackend {
  /** Must resolve only once get(taskId) would succeed (SEP: strong consistency). */
  create(init: McpTaskInit): Promise<McpTaskRecord>;
  get(taskId: string, caller: McpTaskCaller): Promise<McpTaskRecord | undefined>;
  /**
   * Cooperative and idempotent; never throws for terminal tasks. Resolves
   * `false` for an unknown, purged, or foreign-caller task so the adapter can
   * answer `-32602` (part 1, section 4) without a separate, racy `get`.
   */
  cancel(taskId: string, caller: McpTaskCaller): Promise<boolean>;
  /** Abort running work and release resources. */
  close(): Promise<void>;
}

interface McpTaskInit {
  /** Minted by BridgeKit (CSPRNG, at least 128 bits); backends must not mint IDs. */
  taskId: string;
  toolName: string;
  args: unknown;
  ttlMs: number | null;
  pollIntervalMs?: number;
  caller: McpTaskCaller;
  /**
   * Executes the tool through executePortableTool. In-process backends call it;
   * a durable backend may ignore it and enqueue (toolName, args) for a worker
   * that later calls executePortableTool itself.
   */
  run(execution: { signal: AbortSignal; setStatusMessage(text: string): void }): Promise<PortableToolResult<unknown>>;
}
```

- BridgeKit generates the `taskId` and passes it in `McpTaskInit`; backends do
  not mint IDs. `McpTaskRecord` and `McpTaskCaller` shapes are settled in
  implementation.
- Ships `createInMemoryTaskBackend({ maxTasks, defaultTtlMs, pollIntervalMs })`.
  Single process, no restart durability, documented as such.
- **Durable production execution is consumer-owned**, per the approved plan.
  Consumers implement `McpTaskBackend` over their own queue or store.

### State machine and races

`working` to exactly one terminal status, with **first writer wins**. The
in-memory backend serializes transitions per task:

- `cancelled` is written only when the execution settles after the cancel
  signal fired and rejects (part 1, section 5): `cancel` itself signals the
  abort and returns, it does not write a terminal status. A task that ignores
  the signal and completes stays `completed`, and `tasks/cancel` is an ack, not
  a guarantee (SEP). A task that settles without rejecting after the signal is
  `completed`; first writer wins between settlement and TTL expiry.
- Cancel after terminal: no-op, still acked.
- TTL expiry while `working`: transition to `failed` with an expiry message,
  abort the signal, retain the record for one further grace period (the task's
  `pollIntervalMs`, or the backend default when the tool did not set one, at
  least a few seconds so a jittery poller still sees the reason), then purge.
  Note this makes `ttlMs` an execution deadline as well as a retention bound;
  a finite default therefore kills any tool that outlives it (open question 5).
- Purged ID: `tasks/get` returns `-32602`, as the SEP allows.

### Bounds

- `maxTasks` caps retained records (working and terminal). Never evict a record
  before its `ttlMs` elapses: that breaks the retention promised in the handle
  and lets one caller's flood push out another caller's unread result. Records
  whose TTL has elapsed are purged; at capacity with none purgeable, refuse.
  Add a per-caller cap when a `McpTaskCaller` is available.
- At capacity with no evictable record, **do not** silently run synchronously:
  a tool that opted into tasks is presumed long-running and would block the
  request. Return an `isError: true` tool result stating capacity was exceeded.
  This applies to `support: "required"` tools. For `"optional"` tools the
  presumption does not hold (a non-declaring client already runs them inline),
  so whether capacity refusal may fall back to synchronous execution for them
  is part of open question 1.
- Unbounded `ttlMs: null` is allowed only if the consumer sets it explicitly;
  the default is finite. A `null`-TTL record is never purgeable by time, so a
  backend with `maxTasks` and `null` TTLs fills permanently and then refuses
  every create. Either `null` is rejected when `maxTasks` is finite, or
  `null`-TTL records get an explicit consumer-side release path. Decide in
  phase 2 (open question 5).

## Caller binding and auth

The SEP requires an auth check on every task request and recommends unguessable
IDs. BridgeKit has no auth model and the HTTP handler leaves auth to the
application. So the backend receives a `McpTaskCaller` (opaque, derived by an
optional consumer hook such as `resolveTaskCaller(requestCtx)`), stores it at
`create`, and compares on `get`/`cancel`. Without the hook, caller binding is
absent and the unguessable ID is the only guard; the README must say so.
A task whose caller does not match is indistinguishable from an unknown one
(`-32602`), so IDs cannot be probed. The phase 0 spike
(`docs/research/mcp-tasks-phase0-spike.md`) confirmed the request context
carries `ctx.http?.authInfo` (the validated access token) on HTTP and no `http`
object on stdio. The hook is therefore meaningful on HTTP only; on stdio the
connection is a single local peer and the unguessable ID is the only guard.
The test matrix needs an HTTP-only caller-binding row.

## Lifecycle and wiring

- The backend is created **once**, in `createMcpServerFactory`, outside the
  per-server factory closure, and shared by every server the factory produces.
  That satisfies the "fresh HTTP request servers and discarded stdio probes"
  requirement.
- Configured through `CreateMcpServerOptions` (shared by stdio and HTTP):
  `tasks?: { backend?: McpTaskBackend; ... }`. If any tool declares
  `hostExtras.mcp.tasks` and no backend is given, default to the in-memory
  backend.
- Ownership: a default in-memory backend is closed by the stdio handle's
  `close()`. The HTTP handler is the SDK's `McpHttpHandler` returned as-is, whose
  `close()` only tears down in-flight modern exchanges and does not know about
  the backend, so `createMcpHttpHandler` must wrap it to also close the default
  backend (a return-type change that part 3, phase 3 must resolve before wiring). `createMcpServer`
  is deprecated and returns a bare `Server` with no handle, so tasks are not
  wired there. Custom serving uses the exported `createMcpServerFactory`, which
  creates the backend once and so needs an explicit `tasks.backend` from the
  caller or a close hook; its expiry timers must be `unref`'d so an unclosed
  backend cannot keep the process alive. A consumer-supplied backend is **not** closed by BridgeKit.
- Preserve the existing `close()` contract: it aborts requests without awaiting
  tool cleanup. Aborting task signals follows the same rule.

## Rejected alternatives

- **Core `PortableToolResult` variant for "accepted, continue later".** Would
  let a tool decide to detach mid-execution. Rejected: pushes polling into the
  portable contract, forces Pi to define a meaning, and the SEP makes the server
  (adapter), not the tool, the decider.
- **Task state on the SDK `Server`.** Rejected: servers are per-probe and
  per-HTTP-exchange.
- **Use `@modelcontextprotocol/ext-tasks`.** Per the plan it offers requester
  APIs and a legacy sampling/elicitation receiver, not a modern tool-call
  receiver.

## Open questions

1. **Capacity behaviour:** `isError` tool result (proposed), JSON-RPC error, or
   synchronous fallback?
2. **Caller hook:** auth info is confirmed on HTTP only (spike). Is
   `resolveTaskCaller(requestCtx)` worth shipping for an HTTP-only guarantee, or
   should the first delivery rely on unguessable IDs and document the gap?
3. **`pollIntervalMs` / `ttlMs` defaults:** pick concrete numbers from the
   in-memory backend's actual constraints during implementation, not here.
4. **Status message throttling:** should `ctx.progress` -> `statusMessage` be
   rate limited so a chatty tool does not churn backend state?
5. **TTL as deadline:** is it acceptable that `ttlMs` also bounds execution, or
   should execution time be a separate limit from retention?
6. **Admission:** the RFC's admission test favours descriptive, co-located
   metadata and excludes operator runtime config. `support` qualifies;
   `ttlMs` / `pollIntervalMs` look like runtime config and may belong in
   `CreateMcpServerOptions.tasks` (per tool name) instead of `hostExtras`.
