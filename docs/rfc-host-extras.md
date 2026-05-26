# RFC: Per-host extras on `PortableTool`

- **Issue**: [#28](https://github.com/feniix/bridgekit/issues/28)
- **Status**: Draft (design pass before implementation).
- **Target release**: 0.9.0, bundled with [#29](https://github.com/feniix/bridgekit/issues/29) (see §7).
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

### Gap A — Per-tool prompt metadata (`promptSnippet`, `promptGuidelines`, `renderShell`)

**Evidence.** `pi-exa` maintains a `PI_TOOL_METADATA: Record<ExaToolName, PiToolMetadata>` constant in its extensions tree and a custom `registerExaPiTools` loop that reads it on each iteration to spread `promptSnippet` and `promptGuidelines` into `pi.registerTool`. pi's `ToolDefinition` accepts these as first-class fields; bridgekit's `registerPiTools` does not pass them through because `PortableTool` has no place to put them. Result: pi-exa bypasses `registerPiTools` entirely.

**Assignment.** **In scope** for `hostExtras`.

**Justification.** This is the canonical motivation in [#28](https://github.com/feniix/bridgekit/issues/28). The metadata is purely descriptive (no runtime semantics; no side effects on `execute`), it is per-tool (so a parallel map drifts out of sync with the tool list), and it has a direct counterpart on the MCP side (`annotations`). A passive descriptive field is exactly what `hostExtras` should carry.

### Gap B — Pre-`execute` `onUpdate` (`pendingMessage`)

**Evidence.** `pi-sequential-thinking` maintains a `PENDING_MESSAGES: Record<string, string>` constant in its extensions index that pairs each tool name with a "Processing thought…" / "Generating summary…" string, plus a sibling `toPiTool` wrapper whose first action inside `execute` is to call `onUpdate?.({ content: [{ type: "text", text: options.pendingMessage }], details: { status: "pending" } })` **before** any TypeBox validation runs. Today bridgekit has no API to fire an `onUpdate` before `executePortableTool` validates the arguments — `progress` is only available to the handler, which runs after validation succeeds.

**Assignment.** **In scope** for `hostExtras`.

**Justification.** This is a real bridgekit-shaped lifecycle gap: a one-shot, per-tool, pre-validation update that the pi adapter can fire on the tool's behalf. It generalizes cleanly (the data is a string per tool; there is no policy decision the core has to make), and it removes the only reason `pi-sequential-thinking` needs a custom wrapper for *this concern*. Crucially, it's still **descriptive metadata** at the definition site — the consumer declares the message, the adapter handles the wiring — not a callback API that would let consumers inject behavior into the core's execution path.

### Gap C — pi-side argument shaping (`piMaxBytes` / `piMaxLines` "param sandwich")

**Evidence.** `pi-sequential-thinking`'s pi wrapper calls `splitParams(rawParams)` to separate model-supplied arguments from pi-only knobs (`piMaxBytes`, `piMaxLines`) that pi reads but the portable handler must not see. The wrapper then validates only the model-supplied subset against the portable schema. The portable tool definition itself is unaware that pi may inject these knobs.

**Assignment.** **Out of scope** for `hostExtras`.

**Justification.** This is a per-host *argument-shape* concern — pi is augmenting the model's input with operator-supplied configuration before the portable handler runs. Resolving it would require either (a) widening every portable schema to declare its pi-side knobs (mixing concerns) or (b) standing up a host-specific argument-transform pipeline inside the core (an opening that closed [#11](https://github.com/feniix/bridgekit/issues/11) was meant to slam shut). The consumer's `splitParams` is the right place for this: it lives at the host boundary, it owns pi's CLI flag surface, and it can evolve independently of the portable schema. The core has no business knowing about pi flags.

### Gap D — Output truncation with tempfile spillover (`formatToolOutput`)

**Evidence.** `pi-sequential-thinking`'s pi wrapper takes the portable result's structured payload and passes it through a `formatToolOutput(tool.name, payload, effectiveLimits)` helper that imports `@earendil-works/pi-coding-agent` utilities and may spill oversized payloads to a temp file referenced from the text content.

**Assignment.** **Out of scope** for `hostExtras`.

**Justification.** This is pi *presentation* policy: how to render a result inside pi's terminal UI, where to spill bytes, what the operator's `--seq-think-max-bytes` flag means in practice. None of it generalizes to MCP (a structured-content protocol with no display constraints), and absorbing it would couple the portable core to `@earendil-works/pi-coding-agent` — a dependency bridgekit was explicitly extracted to avoid. The consumer's `formatToolOutput` is the right place for this; it stays.

### Summary table

| Gap | What | Assigned to | Rationale |
| --- | --- | --- | --- |
| A | Prompt metadata (`promptSnippet`, `promptGuidelines`, `renderShell`) | **In scope** | Descriptive per-tool data with direct MCP counterpart (`annotations`). |
| B | Pre-`execute` `pendingMessage` | **In scope** | Real lifecycle gap; generalizes as a string per tool, no policy choice for the core. |
| C | `splitParams` for pi-only knobs | **Out of scope** | Per-host argument shaping; stays at the host boundary. |
| D | `formatToolOutput` truncation | **Out of scope** | pi presentation policy that doesn't generalize to MCP. |

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
 * Module augmentation is supported for custom hosts:
 *
 * ```ts
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
     * One-shot text shown by pi before TypeBox validation runs. The pi
     * adapter fires `onUpdate({ content, details: { status: "pending" } })`
     * with this text exactly once per tool call. Absent → no pre-execute
     * update.
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

    /**
     * Passed through to pi's `registerTool({ renderShell })` for tools that
     * need to opt out of pi's default content rendering. Most tools omit.
     */
    renderShell?: "default" | "self";
  };

  mcp?: {
    /**
     * MCP tool annotations. The MCP spec defines `readOnlyHint`,
     * `destructiveHint`, `idempotentHint`, and `openWorldHint` as boolean
     * hints clients may surface to users. The first ship of `hostExtras`
     * may leave this empty and only claim the namespace; see §4.
     */
    annotations?: {
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

The MCP spec (v1.x, which bridgekit currently targets — see [`docs/packaging-invariants.md#inv-mcp-sdk-major`](./packaging-invariants.md#inv-mcp-sdk-major)) defines four annotation hints clients may surface:

- `readOnlyHint`: the tool does not modify its environment.
- `destructiveHint`: the tool may perform destructive updates (applies when `readOnlyHint` is false).
- `idempotentHint`: repeated calls with the same args have no additional effect (applies when `readOnlyHint` is false).
- `openWorldHint`: the tool interacts with an open external world (web search, etc.).

These are hints from tool author to client; they do not change validation or execution. They are the natural counterpart to pi's `promptSnippet` / `promptGuidelines`: descriptive metadata that helps the host present the tool to the user.

**Ship strategy.** The first implementation PR for #28 may consume `hostExtras.pi.*` only and leave `hostExtras.mcp.annotations` declared but unconsumed. The MCP adapter implementation lands in a follow-up patch within the same minor (`0.9.x`). The reason to declare it now is to fix the type shape: a consumer adding `hostExtras.mcp.annotations.readOnlyHint = true` against a 0.9.0 that ignores it should not see a different type error when the 0.9.x adapter starts honoring it.

**Not in 0.9.x.** MCP `outputSchema` (mentioned in passing in the #28 problem statement) is a deliberately separate decision. It interacts with the `TObject` → `TSchema` widening in [#29](https://github.com/feniix/bridgekit/issues/29) and with how `executePortableTool` reasons about a tool's *output* contract, which today it does not. Leave it for a later RFC.

---

## 5. Migration path for existing consumers

_TODO: per-consumer before/after with approximate line deltas._

## 6. Out of scope (enumerated boundaries, not open questions)

_TODO: closed-issue references for #11, #15, #16; MCP outputSchema deferred._

## 7. Sequencing with #29

_TODO: bundle decision._

## 8. Implementation sketch (light)

_TODO: pi adapter wiring._

## 9. Test plan (sketch)

_TODO._

## 10. Closing summary

_TODO: restate the final API shape._
