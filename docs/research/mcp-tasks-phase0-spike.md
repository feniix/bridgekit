# MCP tasks (#127): phase 0 spike results

Date: 2026-10-13. SDK: `@modelcontextprotocol/server` 2.3.1.
Gates: [03-delivery-plan.md](../plans/mcp-tasks/03-delivery-plan.md), phase 0.

Method: a throwaway low-level `Server` (no BridgeKit code) registered with the
extension capability, a `tools/call` handler that returns a flat
`resultType: "task"` handle for declaring clients and a synchronous result
otherwise, and `tasks/get` / `tasks/cancel` / `tasks/update` handlers in the
three-argument custom-schema form. Raw JSON-RPC was driven over a real
`serveStdio` child process (modern and legacy sessions) and through
`createMcpHandler(...).fetch` for HTTP. The probe scripts were not committed;
this note is the record. Re-run before implementation if the SDK version moves.

Scope caveat: BridgeKit's own factory was not exercised, only the SDK
primitives it is built on. Results below are SDK behaviour, not yet BridgeKit
behaviour.

## Answers to the phase 0 questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Are `tasks/get` / `tasks/cancel` routed on the modern era, and with what shapes? | **Yes via the three-argument form**, on stdio and HTTP. The SDK stamps `resultType: "complete"` on the result and adds `_meta` server info; it does not validate the task shape. `tasks/update` routes the same way. Two-argument registration was reported by an earlier review as `-32601` on modern (not re-tested here). |
| 2 | Does `resultType: "task"` from `tools/call` reach the client intact? | **Yes, with an extra field.** The wire result carries `content: []` in addition to the handle (stdio and HTTP). A modern client that treats `CreateTaskResult` as a loose object will ignore it; a strict one may not. |
| 3 | Where are per-request client capabilities readable? | `ctx.mcpReq.envelope["io.modelcontextprotocol/clientCapabilities"]` on the modern era (`CLIENT_CAPABILITIES_META_KEY`). On a legacy connection `envelope` is `undefined`. |
| 4 | Can the extension be advertised from the low-level `Server`, and how does a legacy client look? | **Advertisable** via `capabilities.extensions`. It appears in both `server/discover` and the **legacy `initialize` result**, so advertising cannot be era-scoped by the capability object alone. A legacy client's capabilities carry no envelope, so an envelope-based check treats it as non-declaring even if it sent the extension key in `initialize`. |
| 5 | What auth info does the request context carry? | `ctx.http?.authInfo` (validated access token) on HTTP; `http` is absent on stdio. A caller-binding hook is meaningful on HTTP only. |

## Observed behaviour worth designing around

- **No capability gating from the SDK.** `tasks/get` from a non-declaring modern
  client returned task state (stdio and HTTP). Every `-32021` check in
  [part 1](../plans/mcp-tasks/01-wire-contract.md) is BridgeKit's to implement.
- **Legacy connections reach the custom handlers.** On a clean legacy session,
  `tasks/get`, `tasks/cancel` and `tasks/update` all returned modern-shaped
  results (no `resultType`, no era check). Handlers must era-gate on
  `ctx.mcpReq.envelope === undefined` and answer `-32601`.
- **`tasks/result` and `tasks/list` return `-32601` on both eras** when not
  registered, which matches the SEP for modern and is acceptable for legacy
  because BridgeKit does not advertise legacy tasks.
- **HTTP routing header is enforced by the SDK.** A `tasks/get` whose `Mcp-Name`
  differs from `params.taskId` is rejected `400` / `-32020` before the handler
  runs.
- **Era is sticky per stdio connection.** After modern requests succeed, a
  legacy `initialize` on the same pipe is rejected (`-32022`). This is
  connection lifecycle, not a tasks issue; noted because it makes a mixed-era
  probe misleading.

## Decisions this resolves

Closes open questions 2 and 3 in part 1 (accessor confirmed on both transports;
revision tie supported). Narrows the remaining part 1 items:

- `content: []` on the handle: decide strip versus accept. Stripping needs a
  post-handler hook the low-level `Server` does not obviously offer; accepting
  is the likely answer, and the plan should say so explicitly.
- Legacy `initialize` advertising: accept (harmless: legacy clients ignore
  unknown extension keys and no legacy task is ever created) and document, or
  build a per-era `Server` factory using `McpRequestContext`'s era. The factory
  context exists, so the second is feasible at some complexity cost.

## Still not verified

- BridgeKit's own factory with these registrations (types, `projectCallToolResult`
  bypass for the handle).
- A real SDK **client** consuming a task handle; only raw JSON-RPC was used.
  The v2 client's behaviour on `resultType: "task"` is unknown and matters for
  the integration tests in phase 3.
- `subscriptions/listen` and `notifications/tasks` (deferred by design).
