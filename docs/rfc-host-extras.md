# RFC: Per-host extras on `PortableTool`

- **Issue**: [#28](https://github.com/feniix/bridgekit/issues/28)
- **Status**: Implemented in 0.9.0. Code snippets below show `PortableTool<TParams, THost>` and `PortableToolContext<THost>` — the `<THost>` generic was removed in 0.10.0 (see [#5](https://github.com/feniix/bridgekit/issues/5) and the CHANGELOG). The `hostExtras` design itself is unchanged; mentally substitute `PortableTool<TParams>` and `PortableToolContext` (no generic) when reading the type sketches.
- **Target release**: 0.9.0, bundled with [#29](https://github.com/feniix/bridgekit/issues/29) (see [§7](#7-sequencing-with-29)).
- **Scope**: A single optional field, `PortableTool.hostExtras`, that carries host-specific descriptive metadata and a small set of lifecycle hints. Adapters read the keys they recognize and ignore the rest. Tools that omit `hostExtras` see no behavior change and pay no runtime cost.

This RFC is deliberately narrow. The portable-tool core has spent five minor releases hardening its error model and field-derivation logic without absorbing any pi-side opinion. The goal of `hostExtras` is to close the remaining "consumers bypass `registerPiTools` because the adapter strips data" gap **without** importing host-presentation policy into the core.

---

## 0. TL;DR

Today, two of bridgekit's three known consumers do not use `registerPiTools` — they roll a custom pi registration loop because they need to attach host-specific metadata to each tool. `pi-exa` carries `promptSnippet` / `promptGuidelines` (and reads them from a parallel `PI_TOOL_METADATA` map). `pi-sequential-thinking` ships a per-tool `pendingMessage` from a `PENDING_MESSAGES` constant in its extensions entrypoint and a `toPiTool` wrapper next to it. The flagship adapter is not used by its own production consumers.

The fix is one optional, opaque-per-host field on the tool definition:

```ts
interface PortableTool<TParams, THost> {
  // existing fields unchanged…
  hostExtras?: {
    pi?: { /* see §2 */ };
    mcp?: { /* see §4 */ };
  };
}
```

Adapters consume the keys they understand. Tools that omit `hostExtras` are indistinguishable from today's tools, both on the wire and at the type level.

---

## 1. Three gaps, named and scoped

The consumer evidence comes from three pi-side wrapper patterns in `feniix/pi-extensions`. I describe each at a behavioral level rather than pinning exact line numbers that drift over time.

### Gap A — Per-tool prompt metadata (`promptSnippet`, `promptGuidelines`)

**Evidence.** `pi-exa` maintains a `PI_TOOL_METADATA: Record<ExaToolName, PiToolMetadata>` constant in its extensions tree and a custom `registerExaPiTools` loop that reads it on each iteration to spread `promptSnippet` and `promptGuidelines` into `pi.registerTool`. pi's `ToolDefinition` accepts these as first-class fields; bridgekit's `registerPiTools` does not pass them through because `PortableTool` has no place to put them. Result: pi-exa bypasses `registerPiTools` entirely.

**Note on `renderShell`.** pi's `ToolDefinition` also accepts `renderShell: "default" | "self"` for tools that need to opt out of pi's default content rendering. No known bridgekit consumer currently sets it, so it is **excluded from the 0.9.0 shape** (adding it later is non-breaking since members are optional). The 0.9.0 implementation PR may include it if a consumer surfaces a real need during the migration.

**Assignment.** **In scope** for `hostExtras`.

**Justification.** This is the canonical motivation in [#28](https://github.com/feniix/bridgekit/issues/28). The metadata is purely descriptive (no runtime semantics; no side effects on `execute`), it is per-tool (so a parallel map drifts out of sync with the tool list), and it has a direct counterpart on the MCP side (`annotations`). A passive descriptive field is exactly what `hostExtras` should carry.

### Gap B — Pre-`execute` `onUpdate` (`pendingMessage`)

**Evidence.** `pi-sequential-thinking` maintains a `PENDING_MESSAGES: Record<string, string>` constant in its extensions index that pairs each tool name with a "Processing thought…" / "Generating summary…" string, plus a sibling `toPiTool` wrapper whose first action inside `execute` is to call `onUpdate?.({ content: [{ type: "text", text: options.pendingMessage }], details: { status: "pending" } })` **before** any TypeBox validation runs. Today bridgekit has no API to fire an `onUpdate` before `executePortableTool` validates the arguments — `progress` is only available to the handler, which runs after validation succeeds.

**Assignment.** **In scope** for `hostExtras`.

**Justification.** This is a real bridgekit-shaped lifecycle gap: a one-shot, per-tool, pre-validation update that the pi adapter can fire on the tool's behalf. It generalizes cleanly (the data is a string per tool; there is no policy decision the core has to make), and it removes the only reason `pi-sequential-thinking` needs a custom wrapper for *this concern*. The data is **declarative metadata** at the definition site — the consumer declares the message, the adapter handles the wiring — not a callback API that would let consumers inject behavior into the core's execution path.

**Honest caveat on shape.** Gap A is a registration-time pass-through (spread into `pi.registerTool(...)`); Gap B is a call-time lifecycle action (`onUpdate?.(...)` inside the per-call `execute` closure, before TypeBox validation runs). They share the same `hostExtras.pi` namespace but differ behaviorally: Gap A is pure data, Gap B is data that triggers an adapter-local action per call. The line between "declarative data" and "behavioral injection" sits exactly here; see §6 for the closure rule that holds the boundary.

**Lifecycle interaction with `ctx.progress`.** When the handler also fires `ctx.progress?.(...)` immediately, the adapter-owned pre-validation `onUpdate` and the handler-owned progress update may arrive close together on pi's notification channel. The contract: `pendingMessage`'s `onUpdate` fires **once, before validation**; `ctx.progress` is only available **after validation succeeds** (it's passed via the `ctx` arg to `tool.execute`). They cannot interleave — validation gates the handler. Document this ordering in the implementation PR's test plan (§9 #2).

### Gap C — pi-side argument shaping (`piMaxBytes` / `piMaxLines` "param sandwich")

**Evidence.** `pi-sequential-thinking`'s pi wrapper calls `splitParams(rawParams)` to separate model-supplied arguments from pi-only knobs (`piMaxBytes`, `piMaxLines`) that pi reads but the portable handler must not see. The wrapper then validates only the model-supplied subset against the portable schema. The portable tool definition itself is unaware that pi may inject these knobs.

**Assignment.** **Out of scope** for `hostExtras`.

**Justification.** The load-bearing reason is that `splitParams` cannot be expressed as static metadata at all. The set of pi-only knobs depends on operator CLI configuration (`--seq-think-max-bytes`), not on the tool definition — it is runtime, not declaration-time. No static `hostExtras.pi.piKnobs` declaration could substitute for the runtime transform. The secondary reasons reinforce: resolving Gap C via `hostExtras` would either (a) widen every portable schema to declare pi-side knobs (mixing concerns) or (b) stand up a host-specific argument-transform pipeline inside the core (an opening that closed [#11](https://github.com/feniix/bridgekit/issues/11) was meant to slam shut). The consumer's `splitParams` is the right place for this: it lives at the host boundary, it owns pi's CLI flag surface, and it can evolve independently of the portable schema.

**Closure rule.** Static metadata in `hostExtras` cannot substitute for runtime argument transformation, ever. Future proposals to add `hostExtras.<host>.injectedParams` or similar should be rejected on these grounds — the core has no business knowing about host-side runtime knobs.

### Gap D — Output truncation with tempfile spillover (`formatToolOutput`)

**Evidence.** `pi-sequential-thinking`'s pi wrapper takes the portable result's structured payload and passes it through a `formatToolOutput(tool.name, payload, effectiveLimits)` helper that imports `@earendil-works/pi-coding-agent` utilities and may spill oversized payloads to a temp file referenced from the text content.

**Assignment.** **Out of scope** for `hostExtras`.

**Justification.** This is pi *presentation* policy: how to render a result inside pi's terminal UI, where to spill bytes, what the operator's `--seq-think-max-bytes` flag means in practice. None of it generalizes to MCP (a structured-content protocol with no display constraints), and absorbing it would couple the portable core to `@earendil-works/pi-coding-agent` — a dependency bridgekit was explicitly extracted to avoid. The consumer's `formatToolOutput` is the right place for this; it stays.

### Summary table

| Gap | What | Adapter timing | Assigned to | Rationale |
| --- | --- | --- | --- | --- |
| A | Prompt metadata (`promptSnippet`, `promptGuidelines`) | Registration-time pass-through | **In scope** | Descriptive per-tool data with direct MCP counterpart (`annotations`). |
| B | Pre-`execute` `pendingMessage` | Call-time, before validation | **In scope** | Real lifecycle gap; generalizes as a string per tool, no policy choice for the core. |
| C | `splitParams` for pi-only knobs | — | **Out of scope** | Runtime argument shaping; static metadata cannot express operator-supplied knobs. |
| D | `formatToolOutput` truncation | — | **Out of scope** | pi presentation policy that doesn't generalize to MCP. |

---

## 2. Proposed API shape

```ts
import type { TSchema } from "typebox";

/**
 * Opaque per-host metadata attached to a portable tool definition.
 * Adapters read the keys they recognize and ignore the rest. New host keys
 * are introduced additively; the type uses optional members so adding a key
 * is never a breaking change for existing consumers.
 *
 * **Admission criterion.** A field belongs in `hostExtras.<host>` if and
 * only if it must be **co-located with the tool definition** because a
 * parallel sidecar map would provably drift out of sync with the tool list.
 * That is the load-bearing test: descriptive-per-tool data that one of
 * bridgekit's known hosts already consumes as first-class metadata, and
 * that consumers maintain alongside the tool definition today. Data that
 * depends on operator-supplied runtime config (Gap C) or that pulls in
 * host-specific dependencies for rendering policy (Gap D) does not qualify.
 *
 * **Module augmentation** is supported for custom hosts. TypeScript merges
 * interface augmentations at the **compilation unit** level — the
 * augmentation file must be in scope wherever a tool definition declares
 * `hostExtras["custom-runtime"]`. In multi-package monorepos with split
 * tsconfigs, ensure the augmentation file is included in each consumer
 * package's compile root, or imports of bridgekit will see the augmentation
 * as `undefined` and the field as a type error. bridgekit guarantees the
 * type slot; the consumer is responsible for adapter dispatch.
 *
 * ```ts
 * // packages/my-adapter/src/host-extras.ts
 * declare module "@feniix/bridgekit" {
 *   interface PortableToolHostExtras {
 *     "custom-runtime"?: { something: string };
 *   }
 * }
 * ```
 */
export interface PortableToolHostExtras {
  pi?: {
    /**
     * One-shot text shown by pi before TypeBox validation runs. When
     * `onUpdate` is provided, the pi adapter fires
     * `onUpdate({ content, details: { status: "pending" } })` with this
     * text exactly once per tool call. When `onUpdate` is absent, the
     * adapter silently no-ops (the at-most-once contract; see §9 #2 and #3).
     * Absent on the tool → no pre-execute update at all.
     */
    pendingMessage?: string;

    /**
     * Short string blended into pi's system prompt to summarize when this
     * tool should be called. Passed through verbatim to pi's
     * `registerTool({ promptSnippet })`.
     */
    promptSnippet?: string;

    /**
     * Longer-form guidance bullet points passed through to pi's
     * `registerTool({ promptGuidelines })`. Each entry is one bullet.
     */
    promptGuidelines?: readonly string[];

    // `renderShell` deferred until a consumer surfaces a real need. See §1.
  };

  /**
   * @remarks **Not yet consumed in 0.9.0.** The MCP adapter consumption of
   * `annotations` lands in a follow-up patch within the 0.9.x series. The
   * namespace is declared in 0.9.0 so consumers adding annotations against
   * 0.9.0 see no type-shape change when 0.9.x starts honoring them, but at
   * runtime in 0.9.0 the values are ignored. See §4 for the gate.
   */
  mcp?: {
    /**
     * MCP tool annotations. The MCP spec defines `title`, `readOnlyHint`,
     * `destructiveHint`, `idempotentHint`, and `openWorldHint` as hints
     * clients may surface to users. The first ship of `hostExtras` may leave
     * this declared but unconsumed; see §4 and the `@remarks` above.
     */
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
}

export interface PortableTool<
  TParams extends TSchema = TSchema,
  THost extends string = PortableToolBuiltInHost,
> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute: (
    args: Static<TParams>,
    ctx: PortableToolContext<THost>,
  ) => PortableToolResult | Promise<PortableToolResult>;

  /**
   * Optional per-host metadata. Adapters consume the keys they recognize.
   * Absent → no behavior change; no runtime cost.
   */
  hostExtras?: PortableToolHostExtras;
}
```

### Decision: top-level field on `PortableTool`, not a sidecar option on `registerPiTools`

**Considered alternative.** A second-argument sidecar map on `registerPiTools(pi, tools, { extras: { [toolName]: piExtras } })` and the symmetric thing on `createMcpServer`.

**Why top-level wins.**

1. **Locality.** The pi metadata describes the tool. The tool already exists as a single value at the call site (`definePortableTool({ … })`). A sidecar is exactly the `Record<string, ExtrasFor<host>>` parallel map that both production consumers already maintain and that #28 cites as the problem. Adding a sidecar to bridgekit would reproduce the drift hazard at the bridgekit-API level instead of solving it at the consumer level.

2. **Cross-host symmetry.** MCP's analogous extras (`annotations`) live on the tool registration too. Putting both under one field on the tool means the same tool definition serves both adapters with one source of truth.

3. **Module augmentation works.** Custom hosts can extend `PortableToolHostExtras` via TypeScript module augmentation. A sidecar map keyed by tool-name can't be extended that way without introducing a separate generic on `registerPiTools`.

**The trade-off being made.** A top-level field couples `PortableTool` (defined in `core/define-tool.ts`) to the names of known hosts (`pi`, `mcp`). The mitigation is that the `PortableToolHostExtras` type only contains optional members, no host's extras are referenced by the core's runtime code, and adding or removing a host key is additive at the type level. The core does not import any host-specific code; it only **names** the hosts in a type that's augmentable.

A separate concern: by making `hostExtras` a property on the tool, every host's adapter sees every host's extras (just ignores the unknown ones). This is a feature — the tool author writes one definition; pi-extension authors and MCP-server authors both reach into the same place — and the cost (extras for "host X" living on tools that never run under host X) is negligible because the data is opaque to adapters that don't recognize it.

---

## 3. Zero-cost when absent

**Invariant.** A tool definition without `hostExtras` must be observationally identical to a tool definition that omits the field today. No new properties on the host registration, no new code paths inside the adapter execute hot path, no allocation.

Implementation implication for adapters:

```ts
// pi adapter
const extras = tool.hostExtras?.pi;
if (extras?.pendingMessage !== undefined) {
  // wire the pre-execute onUpdate
}
if (extras?.promptSnippet !== undefined) {
  // include in pi.registerTool
}
// …etc. Each key gated on `!== undefined`.
```

The hot path for a tool with no extras is `tool.hostExtras?.pi` evaluating to `undefined` and short-circuiting. This is verifiable by a test that asserts the pi adapter's `pi.registerTool` call shape is byte-identical for `{ name, title, description, parameters, execute }` vs. `{ name, title, description, parameters, execute, hostExtras: undefined }`.

We will lock this in with a test that snapshots the `PiToolDefinition` object the adapter constructs.

---

## 4. Cross-host symmetry and the `mcp` namespace

Even if the first ship of `hostExtras` lands with no MCP-side extras consumed, the RFC claims the `mcp` namespace so that future MCP additions are non-breaking type changes rather than restructurings of `PortableTool`.

The MCP spec (v1.x, which bridgekit currently targets — see [`docs/packaging-invariants.md#inv-mcp-sdk-major`](./packaging-invariants.md#inv-mcp-sdk-major)) and the installed SDK (`@modelcontextprotocol/sdk` v1.29.0, verified against `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`) define five annotation fields clients may surface:

- `title`: a human-readable title for the tool, distinct from the protocol-level `name`.
- `readOnlyHint`: the tool does not modify its environment.
- `destructiveHint`: the tool may perform destructive updates (applies when `readOnlyHint` is false).
- `idempotentHint`: repeated calls with the same args have no additional effect (applies when `readOnlyHint` is false).
- `openWorldHint`: the tool interacts with an open external world (web search, etc.).

These are hints from tool author to client; they do not change validation or execution. They are the natural counterpart to pi's `promptSnippet` / `promptGuidelines`: descriptive metadata that helps the host present the tool to the user.

**Ship strategy and gate.** The first implementation PR for #28 may consume `hostExtras.pi.*` only and leave `hostExtras.mcp.annotations` declared but unconsumed. The MCP adapter implementation lands in a follow-up patch within the same minor (`0.9.x`). The reason to declare it now is to fix the type shape: a consumer adding `hostExtras.mcp.annotations.readOnlyHint = true` against a 0.9.0 that ignores it should not see a different type error when the 0.9.x adapter starts honoring it.

**The 0.9.x gate (named).** The `mcp` namespace must either be consumed by the MCP adapter within **30 days of 0.9.0 publishing**, OR the namespace declaration must be rolled back in a 0.9.1 patch. The "promise in the type, lie at runtime" window has a hard ceiling. The 0.9.0 release PR opens a tracking issue captioned "0.9.x: wire `hostExtras.mcp.annotations` through createMcpServer" referencing this gate. The implementation PR includes a `@remarks` JSDoc on `hostExtras.mcp` warning "Not yet consumed in 0.9.0" (see §2), so the footgun is at minimum legible to consumers reading the IDE hover or the published `.d.ts`.

**Not in 0.9.x.** MCP `outputSchema` (mentioned in passing in the #28 problem statement) is a deliberately separate decision. It interacts with the `TObject` → `TSchema` widening in [#29](https://github.com/feniix/bridgekit/issues/29) and with how `executePortableTool` reasons about a tool's *output* contract, which today it does not. Leave it for a later RFC.

---

## 5. Migration path for existing consumers

This section describes how each known consumer would migrate once `hostExtras` ships. The RFC's **success criterion** is that the consumer's pi-side wrapper file measurably shrinks.

### `pi-sequential-thinking`

**Before.** The extension carries:

- A `PENDING_MESSAGES: Record<string, string>` constant in `extensions/index.ts` (~10 lines).
- A `toPiTool(tool, options)` wrapper in `extensions/pi-output.ts` (~90 lines), of which roughly half handles the pi-specific `onUpdate` + `formatToolOutput` + `splitParams` plumbing, and the other half is the `executePortableTool` + result-translation code that `registerPiTools` already does.
- A `for (const tool of portableTools)` loop in `extensions/index.ts` that constructs the `PiToolWrapperOptions` per tool and calls `pi.registerTool(toPiTool(tool, …))` (~6 lines).

**After.** The extension can:

1. Move each `pendingMessage` string from `PENDING_MESSAGES` onto its tool's `hostExtras.pi.pendingMessage` at the definition site in `extensions/tools.ts`. The `PENDING_MESSAGES` constant deletes entirely (~10 lines saved in `extensions/index.ts`).
2. Replace the explicit loop with `registerPiTools(pi, portableTools)` (saves another ~4 lines of loop body).
3. Keep `toPiTool` only for the parts `hostExtras` does **not** absorb: `splitParams` (Gap C) and `formatToolOutput` (Gap D). Those concerns remain pi-specific to this extension.

**Approximate diff.** Roughly **15–20 lines** removed from `extensions/index.ts` + `extensions/pi-output.ts` combined. The `toPiTool` wrapper does *not* disappear (Gaps C and D are still consumer-owned), but the pre-execute `onUpdate` and the constant-map plumbing it serves do. The implementation PR for #28 should measure the actual delta and confirm it lands in this range.

> **Honest caveat.** This is a smaller win for `pi-sequential-thinking` than #28's original framing implies, because that extension's wrapper exists *primarily* for `splitParams` + `formatToolOutput`, not for `pendingMessage` alone. The bigger consumer win is the next one.

### `pi-exa`

**Before.** A custom `registerExaPiTools` loop reads `PI_TOOL_METADATA` (a `Record<ExaToolName, PiToolMetadata>` declared in `extensions/tool-guidance.ts`) on every iteration and spreads `promptSnippet` / `promptGuidelines` into `pi.registerTool`.

**After.** Each `PI_TOOL_METADATA` entry moves onto its tool's `hostExtras.pi.{ promptSnippet, promptGuidelines }` at the definition site. The `PI_TOOL_METADATA` constant and the custom registration loop both delete. The extension switches to `registerPiTools(pi, createExaTools(…))`.

**Approximate diff.** This is the bigger win. The custom loop plus `PI_TOOL_METADATA` is on the order of **40–80 lines** of consumer code that can be deleted once `hostExtras` lands (subject to confirmation by the implementation PR). pi-exa is the consumer for which #28 was originally written; the migration here is the load-bearing one.

### `pi-code-reasoning`

**Before.** A custom `registerCodeReasoningPiTools` loop that re-implements `registerPiTools`' execute wiring. The loop exists not because of metadata but because of pre-0.7 error-handling differences. As of 0.7+ those differences have already been removed.

**After.** `pi-code-reasoning` can switch to `registerPiTools(pi, tools)` today. `hostExtras` does not change this — but if/when it adds prompt metadata, the path is the same as pi-exa's. **No code-deletion target driven by this RFC**, but the migration unblocks the next refactor.

### Aggregate success criterion (gating)

The implementation PR for #28 ships only if **`pi-exa` drops its custom registration loop entirely** and switches to `registerPiTools(pi, createExaTools(…))`. This is the actual outcome §0 motivates ("the flagship adapter is not used by its own production consumers") — a line-count proxy is too easy to clear with partial migration. `pi-sequential-thinking`'s migration is bonus evidence but does not gate the PR (its wrapper exists primarily for Gaps C and D, which are out of scope; loop deletion there is not a realistic target).

The line-count guardrail still applies: net additions across `pi-exa` + bridgekit must be **negative** (more deleted than added) for the PR to ship. If the bridgekit implementation grows faster than the consumer shrinks, the bet has failed and the PR reverts.

---

## 6. Out of scope (enumerated boundaries, not open questions)

The following are **not** within `hostExtras`'s scope. They are listed here as boundaries so a future RFC reader doesn't relitigate them under the `hostExtras` heading.

- **Generic middleware / interceptors.** Closed [#11](https://github.com/feniix/bridgekit/issues/11). `hostExtras` carries *data*, not *callbacks*. Adapters consume the data on the tool's behalf; consumers do not inject behavior into the core's execution path through this field.
- **Per-tool retry / cache / auth policies.** Closed [#11](https://github.com/feniix/bridgekit/issues/11). Same boundary as middleware: these are behaviors, not data.
- **Output truncation as a bridgekit concern.** Consumer policy (Gap D). pi-specific; doesn't generalize to MCP; couples the core to `@earendil-works/pi-coding-agent`.
- **Telemetry hooks (`onToolCall`, `onToolError`).** Closed [#16](https://github.com/feniix/bridgekit/issues/16). `hostExtras` is not a back-door for adding callbacks.
- **Tool catalog metadata (`version`, `tags`, `deprecated`, `examples`).** Closed [#15](https://github.com/feniix/bridgekit/issues/15). Catalog metadata describes a tool *across* hosts; if it ever lands, it goes on `PortableTool` directly, not under `hostExtras`. Different decision, different RFC, if at all.
- **Plugin system / dispatch helpers.** Never opened, deliberately. `hostExtras` is opaque data per known host. It is not an extension point for arbitrary host plugins discovered at runtime; bridgekit knows the host names it supports and adapters consume them.
- **MCP `outputSchema`.** Mentioned in #28's problem statement but punted to a separate RFC (see [§4](#4-cross-host-symmetry-and-the-mcp-namespace)).

The first three are direct anti-recommendations from the closed-issue audit; the next three keep this RFC focused on the actual gap rather than absorbing adjacent features; the seventh (MCP `outputSchema`) is deferred to a separate RFC (see [§4](#4-cross-host-symmetry-and-the-mcp-namespace)).

**Why #11 is cited three times.** #11 closed a broad "no behavior injection" boundary — covering middleware, retry/cache/auth policies, AND host-specific argument-transform pipelines (Gap C's justification). The three references to #11 across this RFC (§1 Gap C, §6 item 1, §6 item 2) all map to that single closure under different framings.

### Closure rules for future `hostExtras` additions

To keep this extension channel from becoming a back door for the boundaries §6 closes, every proposed `hostExtras.<host>.<field>` addition must clear three gates:

1. **Co-location test.** Is the data inherently per-tool, such that a parallel sidecar map would provably drift out of sync with the tool list? If it could live equally well outside the tool definition, it does not need `hostExtras`.
2. **Static-metadata test.** Is the field a declaration-time value, or does it depend on operator/runtime configuration? Runtime-dependent fields fail (this is the Gap C rule).
3. **Adapter-local action test.** When the adapter reads the field, does it perform host-local I/O (an `onUpdate` call, a `registerTool` field, an MCP annotation) — or does it trigger consumer-supplied behavior (a callback, a middleware step)? Consumer-supplied behavior is closed (#11/#16); adapter-local actions are admissible. `pendingMessage` (Gap B) sits exactly at this line and qualifies because the action is a single host-local `onUpdate` with consumer-supplied **data**, not a consumer-supplied **callback**.

A field that passes all three gates is admissible. A field that fails any gate is rejected without further debate — re-litigating the closed boundaries belongs in a separate RFC against #11/#15/#16, not in a `hostExtras` PR.

---

## 7. Sequencing with #29

[#29](https://github.com/feniix/bridgekit/issues/29) widens `CreateMcpServerOptions.tools` from `readonly PortableTool<TObject>[]` to `readonly PortableTool<TSchema>[]` so that tools whose parameters use TypeBox combinators (`Type.Intersect`, `Type.Composite`, `Type.Union` of `TObject`s) can register without a cast.

**Does #28 implementation need #29 first?** The pi-side work (Gaps A, B) has **no technical dependency** on #29. The MCP-side work intersects #29 only for consumers using combinator schemas (`Type.Intersect`/`Composite`) AND `hostExtras.mcp.annotations` simultaneously — a narrow scenario with no cited consumer today. The bundling is therefore an **ergonomics + upgrade-cognitive-load** decision, not a hard dependency.

The honest case for bundling is upgrade cost: a consumer moving from 0.8.x to 0.9.0 absorbs one migration (widened `TSchema` constraint + new `hostExtras` field) rather than two consecutive minors. That is the strongest argument; the original "type ergonomics for the Intersect+annotations consumer" framing was thin.

**Recommendation (conditional).** Bundle both in **0.9.0** as the preferred path. Land #29 first as a separate commit / sub-PR within the 0.9.0 series so each landing is independently revertable.

**Fallback path.** If #29 implementation runs into unexpected friction (deep type-inference issues, downstream cast leaks discovered during the widening), ship #28 standalone as **0.8.4** to unblock `pi-exa`'s migration. Do not block #28 indefinitely waiting on #29. The bundling is "preferred when both land cleanly"; the dependency is not technical.

**What does *not* need to be sequenced before #28.**

- Closed-error-model items (#33, #35, #36, #38): all resolved as of 0.8.3.
- The result-guards (#30): already shipped in 0.7.
- Telemetry / middleware (#11, #16): closed boundaries, not prerequisites.

---

## 8. Implementation sketch (light)

This is intentionally not a complete patch — just enough to make the RFC implementable. The change to `registerPiTools` is purely additive, but the implementation PR also needs a **type-level widening** of the internal `PiToolDefinition` interface in `src/adapters/pi.ts`. Today that interface has exactly five fields (`name`, `label`, `description`, `parameters`, `execute`); the spread of `promptSnippet` / `promptGuidelines` won't compile in strict mode until the interface accepts them. The implementer should verify the field types against whatever the actual pi host SDK (`@earendil-works/pi-coding-agent` or successor) exposes for these fields — the RFC's shapes are derived from consumer-code usage, not from a published pi SDK type the bridgekit project depends on.

```ts
// src/adapters/pi.ts (sketch, simplified)

// Widen the internal type to accept the new fields. Each is optional;
// existing consumers see no shape change.
type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (...) => Promise<PiToolResult>;
  // New, all optional:
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
};

export function registerPiTools(
  pi: PiToolRegistration,
  tools: readonly PortableTool<TSchema>[],
  options: RegisterPiToolsOptions = {},
): void {
  const errorHandling = options.errorHandling ?? "return";
  // …existing deprecation-warning bookkeeping…

  for (const tool of tools) {
    const piExtras = tool.hostExtras?.pi;

    pi.registerTool({
      name: tool.name,
      label: tool.title,
      description: tool.description,
      parameters: tool.parameters,
      // Spread known pi extras. Each field is gated on `!== undefined` so
      // tools without `hostExtras.pi` build a registration object that is
      // byte-identical to today's shape — zero-cost when absent.
      ...(piExtras?.promptSnippet !== undefined && { promptSnippet: piExtras.promptSnippet }),
      ...(piExtras?.promptGuidelines !== undefined && { promptGuidelines: piExtras.promptGuidelines }),

      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        // Lifecycle hook: fire the pre-execute update exactly once,
        // before TypeBox validation runs. Adapter does the work; the
        // tool definition only declares the string.
        if (piExtras?.pendingMessage !== undefined) {
          onUpdate?.({
            content: [{ type: "text", text: piExtras.pendingMessage }],
            details: { status: "pending" },
          });
        }

        // …existing executePortableTool + result-translation code, unchanged…
      },
    });
  }
}
```

**Key properties of the sketch.**

- Additive. No existing field on `PortableTool` changes; no existing argument to `registerPiTools` changes; no existing return path changes.
- Zero-cost when absent. The `tool.hostExtras?.pi` lookup is undefined for today's tools; every subsequent `?.` short-circuits.
- Adapter-local. The pi adapter knows about `hostExtras.pi`; the MCP adapter knows about `hostExtras.mcp`; neither imports the other. The asymmetry that's been load-bearing since extraction is preserved.
- The MCP adapter sketch is the same shape: `const mcpExtras = tool.hostExtras?.mcp` at the top of `setRequestHandler(ListToolsRequestSchema, …)`'s tool mapping, and `annotations: mcpExtras?.annotations` added to the emitted `Tool` only when defined. We do not write that sketch out here because the first 0.9.0 implementation PR may choose to ship pi-side consumption only and leave MCP consumption for 0.9.x — the type shape is what claims the namespace; the adapter wiring is a follow-up.

---

## 9. Test plan (sketch)

Lifecycle-relevant assertions for the implementation PR. **Tests marked [GATING] are merge-blockers** for the 0.9.0 PR; advisory tests can land in follow-up patches but must exist before any consumer migration goes to production.

1. **[GATING] Zero-cost shape — `hostExtras` absent.** A tool with no `hostExtras` produces a `PiToolDefinition` whose own-property keys exactly match today's set (`name`, `label`, `description`, `parameters`, `execute`). Snapshot-style test on the captured argument to `pi.registerTool`.
2. **[GATING] Zero-cost shape — `hostExtras: {}` (empty object).** A tool with `hostExtras: {}` is observationally identical to a tool that omits the field at the adapter-output level. Note that at the JSON-serialization level `hostExtras: {}` differs from absent — consumers that round-trip tool definitions through JSON should prefer omitting the field over setting an empty object; this is a documentation concern, not an invariant.
3. **[GATING] `pendingMessage` fires before validation.** Given a tool with `hostExtras.pi.pendingMessage` and a schema that rejects the supplied args, `onUpdate` is called once with the pending message **before** the validation-failure result is returned. Order-asserting test.
4. **[GATING] `pendingMessage` is at-most-once.** Two sub-cases: (a) no second invocation from `executePortableTool`'s own progress wiring when `onUpdate` IS provided; (b) silent no-op (no throw, no side effect) when `onUpdate` is `undefined`.
5. **`pendingMessage` × `errorHandling: "throw"`.** Given a tool with `pendingMessage` set, validation that would fail, and `errorHandling: "throw"`: the `onUpdate` fires once, then `PortableToolExecutionError` is thrown. The pending message reaches the channel before the throw — `onUpdate` is not silently swallowed by the catch.
6. **[GATING] `promptSnippet` / `promptGuidelines` pass-through.** Given a tool with each field set, the call to `pi.registerTool` carries the same value verbatim.
7. **MCP annotations.** Given a tool with `hostExtras.mcp.annotations.readOnlyHint = true`, the `Tool` returned by `tools/list` carries the annotation. **Lands when 0.9.x adapter consumption ships** (see §4 gate). A failing/skipped placeholder test should exist in 0.9.0 documenting the expected wire shape, so the 0.9.x patch has a target.
8. **Unknown-host keys ignored.** Given a tool with `hostExtras["custom-host"]` populated via module augmentation, neither the pi nor MCP adapter looks at it (no throw, no log, no spread into the host registration).
9. **[GATING] Module augmentation smoke-fixture.** Add a typecheck fixture inside `scripts/smoke-package.mjs`'s `assertTypesCompile` block that declares `interface PortableToolHostExtras { "custom-runtime"?: { something: string } }` against the installed declarations and assigns `hostExtras: { "custom-runtime": { something: "x" } }` on a tool. The fixture must compile cleanly. Locks the augmentation path against future declaration changes that would break it silently.
10. **`smoke-package.mjs` runtime keys.** The `assertRuntimeExports` allow-list does not change. `PortableToolHostExtras` is exported as `interface` only (zero runtime footprint), so `Object.keys(core)` is unchanged.

---

## 10. Closing summary

The proposed shape:

```ts
interface PortableTool<TParams, THost> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute: (args, ctx) => PortableToolResult | Promise<PortableToolResult>;
  hostExtras?: {
    pi?: {
      pendingMessage?: string;
      promptSnippet?: string;
      promptGuidelines?: readonly string[];
    };
    mcp?: {
      // Not yet consumed in 0.9.0; lands in 0.9.x (see §4 gate).
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
    };
  };
}
```

The bet: an opaque-per-host, descriptive-data field is the smallest possible API that closes the consumer-wrapper-duplication gap without absorbing any host policy into the core. Either the bet pays off — `pi-exa` drops its custom registration loop entirely when `hostExtras` lands (see [§5](#5-migration-path-for-existing-consumers) gating criterion) — or this RFC was wrong about the gap, and the implementation PR reverts.

This RFC opens the design conversation. Implementation lives in a follow-up PR against the same issue, bundled with #29 in 0.9.0.
