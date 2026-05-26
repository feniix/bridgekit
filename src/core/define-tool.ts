import type { Static, TSchema } from "typebox";

export interface PortableToolResult<TStructured extends Record<string, unknown> = Record<string, unknown>> {
  /** Plain text sent back to the model in every host. */
  text: string;
  /** Structured data for hosts that support it. Preferred by both pi and MCP adapters. */
  structuredContent?: TStructured;
  /**
   * Legacy/adapter debug details used only when `structuredContent` is absent.
   *
   * @deprecated Slated for removal in 1.0. Prefer `structuredContent` for
   * machine-readable data. Both adapters still fall back to this field, but
   * new tool code should not set it.
   */
  details?: Record<string, unknown>;
  /** Tool-level error flag. Throw for unexpected adapter/runtime failures. */
  isError?: boolean;
}

/**
 * Discriminated union describing the shape `executePortableTool` puts into a
 * failure result's `structuredContent`, and that the pi adapter exposes as
 * `PortableToolExecutionError.details`.
 *
 * - `kind: "validation"` — TypeBox rejected the args. Always carries the
 *   offending tool name and the validation errors.
 * - `kind: "domain"` — the tool's own handler returned `isError: true`. The
 *   shape of the rest of the object is whatever the handler chose to expose.
 */
export type PortableToolErrorDetails =
  | { kind: "validation"; tool: string; validationErrors: PortableValidationError[] }
  | ({ kind: "domain" } & Record<string, unknown>);

export interface PortableValidationError {
  field: string;
  message: string;
}

export type PortableToolBuiltInHost = "pi" | "mcp" | "test";

export type PortableToolHost<TExtension extends string = never> = PortableToolBuiltInHost | TExtension;

export interface PortableToolContext<THost extends string = PortableToolBuiltInHost> {
  host: THost;
  signal?: AbortSignal;
  progress?: (update: PortableToolResult) => void;
}

/**
 * Pi-specific entries on `PortableTool.hostExtras`. Read only by the pi
 * adapter; the MCP adapter ignores this namespace.
 *
 * **Snapshot semantics.** Pi-side fields are read at registration time:
 * `pendingMessage` is re-read at each tool invocation (so a mutation between
 * two calls would be observed), while `promptSnippet` / `promptGuidelines`
 * are captured once during `registerPiTools` and never re-read. Treat all
 * pi-side fields as immutable once `registerPiTools` returns.
 *
 * @see PortableToolHostExtras
 */
export interface PiHostExtras {
  /**
   * One-shot text the pi adapter emits as `onUpdate(...)` exactly once,
   * **before** TypeBox validation runs. When unset (or absent on the tool),
   * no pre-execute update is emitted. An empty string is treated as unset
   * and produces no update. When the registered pi host does not supply an
   * `onUpdate` callback at call time, the adapter silently no-ops.
   *
   * Held by reference at registration time; treat `pendingMessage` as
   * immutable once attached to a tool definition.
   *
   * @example
   * hostExtras: { pi: { pendingMessage: "Processing..." } }
   */
  pendingMessage?: string;

  /**
   * Short string blended into pi's system prompt to summarise when this tool
   * should be called. Passed through verbatim to pi's `registerTool` call.
   *
   * Whether the installed pi SDK reads this field is the pi host's concern;
   * bridgekit's contract is to pass it through unmodified when set.
   */
  promptSnippet?: string;

  /**
   * Longer-form guidance bullet points passed through to pi's `registerTool`
   * call. Each entry is one bullet. Held by reference — treat as immutable
   * once attached to a tool definition.
   */
  promptGuidelines?: readonly string[];
}

/**
 * MCP-specific entries on `PortableTool.hostExtras`. Read only by the MCP
 * adapter; the pi adapter ignores this namespace.
 *
 * @see PortableToolHostExtras
 */
export interface McpHostExtras {
  /**
   * MCP tool annotations attached to `tools/list` entries. Hints clients may
   * surface to users; do not affect validation or execution.
   *
   * The annotations object is shallow-cloned at `createMcpServer`
   * construction; post-construction mutation of the original object does
   * not affect subsequent `tools/list` responses. Consumers do not need to
   * defensively clone before passing.
   *
   * An empty annotations object (`{}`) is treated as semantically identical
   * to omitting the field — the resulting `Tool` entry has no `annotations`
   * key on the wire.
   *
   * @see https://modelcontextprotocol.io/specification (Tool annotations)
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Opaque per-host metadata attached to a portable tool definition. Adapters
 * read the keys they recognise and ignore the rest. Tools that omit
 * `hostExtras` see no behavior change and pay no runtime cost — every adapter
 * short-circuits on `tool.hostExtras?.<host>` being `undefined`.
 *
 * The shape is **module-augmentable** for custom hosts:
 *
 * ```ts
 * declare module "@feniix/bridgekit" {
 *   interface PortableToolHostExtras {
 *     "custom-runtime"?: { something: string };
 *   }
 * }
 * ```
 *
 * The augmentation must be in scope wherever a tool sets
 * `hostExtras["custom-runtime"]`. bridgekit guarantees the type slot; the
 * consumer is responsible for adapter dispatch.
 */
export interface PortableToolHostExtras {
  pi?: PiHostExtras;
  mcp?: McpHostExtras;
}

export interface PortableTool<TParams extends TSchema = TSchema, THost extends string = PortableToolBuiltInHost> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  execute: (args: Static<TParams>, ctx: PortableToolContext<THost>) => PortableToolResult | Promise<PortableToolResult>;
  /**
   * Optional per-host metadata. Adapters consume the keys they recognise;
   * unknown host namespaces are ignored. Absent → no behavior change.
   *
   * @see PortableToolHostExtras
   * @see docs/rfc-host-extras.md for design rationale (admission criteria,
   * why a top-level field beats a sidecar map, closure rules for future
   * additions).
   */
  hostExtras?: PortableToolHostExtras;
}

export function definePortableTool<TParams extends TSchema, THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TParams, THost>,
): PortableTool<TParams, THost> {
  return tool;
}
