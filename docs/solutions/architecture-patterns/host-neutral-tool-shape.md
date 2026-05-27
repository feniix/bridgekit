---
title: "Host-neutral tool shape: closed host union with namespaced hostExtras"
date: 2026-05-27
category: docs/solutions/architecture-patterns
module: core/define-tool + adapters/{pi,mcp}
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Designing a library whose core type defines a unit of work executed by multiple host runtimes (pi, MCP, CLI, custom)"
  - "Tempted to add a `<THost extends string>` generic so consumers can extend the host union"
  - "Tempted to add per-host fields (annotations, prompt hints, lifecycle hooks) to the top-level core type"
  - "Auditing an existing host union for unused generic surface that no consumer relies on"
related_components:
  - documentation
  - testing_framework
tags: [host-neutral, type-system, extension-points, module-augmentation, yagni, adapter-pattern]
---

# Host-neutral tool shape: closed host union with namespaced hostExtras

## Context

Bridgekit's core proposition is "write one tool, expose it through multiple hosts." That premise forces a recurring question: how do you let host-specific concerns into the type system without polluting the host-neutral tool definition?

The repo's own 0.6.0 → 0.13.0 arc walked through both wrong answers before converging on the right one:

1. **Wrong answer A — open generic.** Through 0.9.x, `PortableTool`, `PortableToolContext`, `definePortableTool`, `executePortableTool`, and `validatePortableToolArgs` all carried a second generic parameter `<THost extends string>` and a companion type alias `PortableToolHost<TExtension extends string> = "pi" | "mcp" | "test" | TExtension`. The intent was "custom-host adapters can widen the host union with their own literal." The pre-1.0 audit (issue #5, shipped in 0.10.0) found **zero consumers** using the generic — across the repo, the three known downstream consumers (`pi-sequential-thinking`, `pi-exa`, `pi-code-reasoning`), and the test fixtures. The generic widened five signatures, taxed every call site with a redundant parameter, and bought nothing.
2. **Wrong answer B — per-host fields on the top-level type.** The natural impulse for "the pi host needs a `pendingMessage` and `promptGuidelines`; the MCP host needs `annotations`" is to add those fields directly to `PortableTool`. That fights the core proposition — a tool definition is supposed to be host-neutral, so dumping pi-shaped and MCP-shaped fields onto it makes every adapter pay attention to fields it doesn't own.

The friction that surfaced both wrong answers: pi-side tools genuinely needed metadata (a "Processing..." `pendingMessage` fires a pre-execute `onUpdate`; `promptGuidelines` is passed through to `pi.registerTool`), and MCP-side tools genuinely needed annotations (`readOnlyHint`, `destructiveHint`, etc. for `tools/list`). Refusing to model them at all would have pushed all per-host metadata into the adapter call site, scattering knowledge across the codebase.

The pattern that resolved this — shipped piecemeal across 0.9.0 (hostExtras), 0.10.0 (host-union closure), and reinforced through 0.13.0 (the contravariance fix kept the type-system surface small) — is the durable architectural answer.

## Guidance

For a library whose core type is consumed by multiple host adapters, apply two paired decisions:

### Decision 1: Close the host union

Declare the host union as a fixed literal union, not a generic. Custom hosts cast at the adapter boundary; the type-system surface stays small at the cost of one cast per adapter.

```ts
// src/core/define-tool.ts
export type PortableToolBuiltInHost = "pi" | "mcp" | "test";

export interface PortableToolContext {
  host: PortableToolBuiltInHost;
  signal?: AbortSignal;
  progress?: (update: { content: string; details?: unknown }) => void;
}

export interface PortableTool<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext) => Promise<PortableToolResult>;
  hostExtras?: PortableToolHostExtras;
}
```

A consumer building a custom-host adapter casts at the adapter boundary:

```ts
// Inside the custom-host adapter only — never in shared tool files.
// A direct `as "custom-runtime"` fails under strict (TS2352 — no overlap);
// cast through `unknown` instead.
const ctx: PortableToolContext = {
  host: "custom-runtime" as unknown as PortableToolBuiltInHost,
};
await executePortableTool(tool, args, ctx);
```

The cast lies at the type-system boundary, so `switch (ctx.host) { ... default: assertNever(ctx.host); }` patterns will fall through on the custom literal at runtime. For custom dispatch, carry the host identifier on an adapter-owned field rather than on `ctx.host`, or do a runtime allowlist check before exhaustive narrowing. That tradeoff is acceptable because (a) it stays inside the custom adapter, and (b) it pays for the simplification at every other call site.

### Decision 2: Per-host metadata lives in a namespaced `hostExtras` slot

Add a single optional `hostExtras` field whose shape is module-augmentable. Each adapter reads only its own namespace.

```ts
// src/core/define-tool.ts
export interface PortableToolHostExtras {
  pi?: {
    pendingMessage?: string;
    promptSnippet?: string;
    promptGuidelines?: readonly string[];
  };
  mcp?: {
    annotations?: {
      title?: string;
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
  };
}
```

A custom-host adapter claims its own namespace via TypeScript module augmentation:

```ts
// In the custom-host adapter package, e.g. @scope/bridgekit-custom-host
declare module "@feniix/bridgekit" {
  interface PortableToolHostExtras {
    customRuntime?: {
      priority?: "low" | "normal" | "high";
      retryPolicy?: { maxAttempts: number; backoffMs: number };
    };
  }
}
```

Each adapter's read path gates on `!== undefined`:

```ts
// src/adapters/pi.ts
const pi = tool.hostExtras?.pi;
if (pi?.pendingMessage !== undefined) {
  onUpdate({ content: pi.pendingMessage });
}
if (pi?.promptGuidelines !== undefined) {
  // Spread-copy at the boundary — see "Why this matters" below.
  registration.promptGuidelines = [...pi.promptGuidelines];
}
```

```ts
// src/adapters/mcp.ts
const mcp = tool.hostExtras?.mcp;
const annotations = mcp?.annotations;
const listEntry = {
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  ...(annotations !== undefined && { annotations }),
};
```

The undefined-gate is load-bearing: tools that don't set `hostExtras` produce **byte-identical** wire payloads to pre-`hostExtras` versions. That's the migration guarantee that let bridgekit ship `hostExtras` as a non-breaking 0.9.0 addition.

## Why This Matters

- **Generic parameters that no consumer uses are pure cost.** Every type signature gets wider, every test fixture has to spell out the generic argument, every error message includes it. Type parameters should follow consumer evidence, not anticipated extension. Pre-1.0 audits should look for them explicitly; post-1.0 they cost a breaking change to remove.
- **Closed unions surface API contracts in errors.** When `ctx.host` is `"pi" | "mcp" | "test"`, an `@ts-expect-error` pin against `{ host: "custom-adapter" }` catches drift. With an open generic, that test pins nothing — the type system accepts anything. Bridgekit's `src/core/execute-tool.test.ts` carries exactly this pin against the fixed-union shape.
- **Namespaced extension beats top-level extension because adapters don't pay for fields they don't own.** The pi adapter never has to look at `mcp.annotations`; the MCP adapter never has to look at `pi.promptGuidelines`. Future host adapters add a namespace without touching existing adapters' read paths.
- **Module augmentation is the right escape hatch for custom hosts.** It keeps the public type-system surface small (no generic parameter for the 99% case) while still giving the 1% case a typed path. The cast through `unknown` for `ctx.host` is the only ergonomic cost.
- **Byte-identical wire payloads are a feature.** The `hostExtras?.<host> !== undefined` gate means rollout is risk-free: tools that don't opt in produce the same `tools/list` and `registerTool` payloads they did before the field existed. This is what makes the pattern safe to introduce mid-release-train.

The corollary: when you find yourself reaching for an open generic *or* per-host top-level fields, treat both as smells. The honest question is "does this metadata belong to the host adapter or to the tool itself?" Per-host metadata always belongs to the adapter — which means it belongs in a namespace owned by that adapter.

## When to Apply

- Designing or refactoring a library where one core type is consumed by multiple host/runtime adapters
- Auditing an existing host-union or context-host generic for unused surface (consumer-evidence check)
- Adding a new per-host concern (lifecycle hook, prompt hint, wire annotation) and the obvious place is the top-level type
- Onboarding a custom-host adapter and tempted to widen the host union

## Examples

### Before (0.6.x — 0.9.x) — open generic, no extension namespace

```ts
// Wrong shape 1: <THost> generic.
export type PortableToolHost<TExtension extends string = never> =
  "pi" | "mcp" | "test" | TExtension;

export interface PortableTool<
  TParams extends TSchema = TSchema,
  THost extends string = never,
> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (
    args: Static<TParams>,
    ctx: PortableToolContext<THost>,
  ) => Promise<PortableToolResult>;
}

// At the call site, every consumer pays the generic tax:
const tool: PortableTool<typeof params, never> = definePortableTool<
  typeof params,
  never
>({ /* ... */ });
```

```ts
// Wrong shape 2: pi-specific fields on the top-level type.
export interface PortableTool<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext) => Promise<PortableToolResult>;
  // These don't belong here — they're pi adapter concerns.
  pendingMessage?: string;
  promptGuidelines?: readonly string[];
  // And these don't belong here either — they're MCP adapter concerns.
  annotations?: { readOnlyHint?: boolean; /* ... */ };
}
```

### After (0.10.0+) — closed union, namespaced extras

```ts
// src/core/define-tool.ts — host-neutral, no host-specific fields.
export type PortableToolBuiltInHost = "pi" | "mcp" | "test";

export interface PortableTool<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext) => Promise<PortableToolResult>;
  hostExtras?: PortableToolHostExtras;
}

export interface PortableToolHostExtras {
  pi?: PiHostExtras;
  mcp?: McpHostExtras;
}
```

```ts
// A tool definition stays host-neutral.
const readFileTool = definePortableTool({
  name: "read_file",
  description: "Read a file from disk.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async ({ path }, ctx) => ({
    text: await fs.readFile(path, "utf8"),
  }),
  hostExtras: {
    pi: {
      pendingMessage: "Reading file…",
      promptGuidelines: ["Use absolute paths."],
    },
    mcp: {
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  },
});
```

```ts
// Custom-host adapter package augments the namespace.
declare module "@feniix/bridgekit" {
  interface PortableToolHostExtras {
    workflowEngine?: {
      timeoutMs?: number;
      retryable?: boolean;
    };
  }
}
```

### Adversarial pin that catches drift

```ts
// src/core/execute-tool.test.ts
// Pin the host union shape against drift. If someone re-introduces a <THost>
// generic, or widens PortableToolBuiltInHost, this fails at type-check time.

// @ts-expect-error - "custom-adapter" is not in the fixed host union
const badCtx: PortableToolContext = { host: "custom-adapter" };

// Valid built-in hosts compile cleanly:
const piCtx: PortableToolContext = { host: "pi" };
const mcpCtx: PortableToolContext = { host: "mcp" };
const testCtx: PortableToolContext = { host: "test" };
```

## Related

- `docs/rfc-host-extras.md` — original design rationale for the `hostExtras` namespace (now superseded post-0.10.0 but kept for historical context)
- `docs/extraction.md` — repo-level history of why the four-entrypoint shape is load-bearing
- Bridgekit `CHANGELOG.md` entries for 0.9.0 (hostExtras introduction), 0.10.0 (host-union closure), 0.13.0 (contravariance fix on `promptGuidelines`)
- GitHub issues [#5](https://github.com/feniix/bridgekit/issues/5) (drop `<THost>`), [#28](https://github.com/feniix/bridgekit/issues/28) (introduce `hostExtras`), [#60](https://github.com/feniix/bridgekit/issues/60) (widen `PiToolDefinition.promptGuidelines`)
