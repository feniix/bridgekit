import type { Static, TSchema } from "typebox";

export interface PortableToolResult<TStructured = Record<string, unknown>> {
  /** Plain text sent back to the model in every host. */
  text: string;
  /**
   * Structured data for hosts that support it. Preferred by both pi and MCP
   * adapters. Any JSON value is accepted (object, array, primitive, `null`);
   * the default type parameter keeps the common object case ergonomic.
   * Non-object values reach MCP `structuredContent` directly on the modern
   * era, are wrapped as `{ result: value }` by the SDK for legacy clients,
   * and are wrapped the same way in pi's renderer-facing `details`.
   */
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

export interface PortableToolContext {
  host: PortableToolBuiltInHost;
  signal?: AbortSignal;
  /**
   * Host progress channel. Pi maps each update to `onUpdate`; MCP maps it to
   * `notifications/progress` when the request carried a `progressToken`
   * (`progress` is a monotonic per-call counter and `message` is `update.text`).
   */
  progress?: (update: PortableToolResult<unknown>) => void;
}

/**
 * Optional TUI renderer for the tool call line (before execution).
 * Receives `(args, theme, context)` and returns a pi-tui Component.
 * BridgeKit passes this through verbatim — no validation or wrapping.
 */
// biome-ignore lint/suspicious/noExplicitAny: host-neutral pass-through; importing pi-tui types would couple core to pi, while `unknown` params would reject typed consumer renderers under strictFunctionTypes
export type PiToolCallRenderer = (args: any, theme: any, context: any) => any;

/**
 * Optional TUI renderer for the tool result (after execution).
 * Receives `(result, options, theme, context)` and returns a pi-tui Component.
 * `options.expanded` is toggled by the user via Ctrl+O in pi's TUI.
 * BridgeKit passes this through verbatim — no validation or wrapping.
 */
// biome-ignore lint/suspicious/noExplicitAny: host-neutral pass-through; importing pi-tui types would couple core to pi, while `unknown` params would reject typed consumer renderers under strictFunctionTypes
export type PiToolResultRenderer = (result: any, options: any, theme: any, context: any) => any;

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

  renderCall?: PiToolCallRenderer;

  renderResult?: PiToolResultRenderer;
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

/**
 * Object-rooted outputs keep the open-record intersection so handlers may
 * return extra keys beyond the schema; array and primitive roots are used as-is
 * (neither is assignable to `Record<string, unknown>`).
 */
type SchemaOutput<T> = [T] extends [readonly unknown[]] ? T : [T] extends [object] ? T & Record<string, unknown> : T;

/** Successes satisfy the output schema; literal domain failures retain arbitrary data. */
type SchemaResult<TOutput extends TSchema> =
  | (PortableToolResult<unknown> & {
      structuredContent: SchemaOutput<Exclude<Static<TOutput>, undefined>>;
      isError?: false;
    })
  | (PortableToolResult<unknown> & { isError: true });

type CheckedResult<TResult extends PortableToolResult<unknown>, TOutput extends TSchema | undefined> = [
  TOutput,
] extends [TSchema]
  ? TResult & SchemaResult<NoInfer<Extract<TOutput, TSchema>>>
  : TResult;

export interface PortableTool<
  TParams extends TSchema = TSchema,
  TResult extends PortableToolResult<unknown> = PortableToolResult<unknown>,
  TOutput extends TSchema | undefined = TSchema | undefined,
> {
  name: string;
  title: string;
  description: string;
  parameters: TParams;
  /**
   * TypeBox schema for successful structuredContent. Any JSON Schema root is
   * accepted except a top-level `$ref` (`Type.Ref` / `Type.Cyclic`); objects,
   * object intersections, arrays, primitives and unions are all valid.
   * Literal isError:true results are exempt. Treat this schema and parameters
   * as immutable after registration, including replacing either schema object.
   */
  outputSchema?: TOutput;
  execute: (
    args: Static<TParams>,
    ctx: PortableToolContext,
  ) => CheckedResult<TResult, TOutput> | Promise<CheckedResult<TResult, TOutput>>;
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

// Infer the entire handler (including success/domain unions), rather than
// inferring TResult through an intersection that can select just one branch.
export function definePortableTool<
  TParams extends TSchema,
  TOutput extends TSchema,
  TExecute extends (
    args: Static<TParams>,
    ctx: PortableToolContext,
  ) => SchemaResult<NoInfer<TOutput>> | Promise<SchemaResult<NoInfer<TOutput>>>,
>(
  tool: Omit<PortableTool<TParams, PortableToolResult, TOutput>, "execute" | "outputSchema"> & {
    outputSchema: TOutput;
    execute: TExecute;
  },
): PortableTool<TParams, Awaited<ReturnType<TExecute>>, TOutput>;
export function definePortableTool<TParams extends TSchema, TResult extends PortableToolResult<unknown>>(
  tool: PortableTool<TParams, TResult> & { outputSchema?: undefined },
): PortableTool<TParams, TResult, undefined>;
export function definePortableTool<
  TParams extends TSchema,
  TOutput extends TSchema,
  TExecute extends (
    args: Static<TParams>,
    ctx: PortableToolContext,
  ) => SchemaResult<NoInfer<TOutput>> | Promise<SchemaResult<NoInfer<TOutput>>>,
>(
  tool: Omit<PortableTool<TParams, PortableToolResult, TOutput>, "execute" | "outputSchema"> & {
    outputSchema?: TOutput;
    execute: TExecute;
  },
): PortableTool<TParams, Awaited<ReturnType<TExecute>>, TOutput>;
// Schema-erased annotations and explicit legacy <TParams, TResult> calls use
// this compatibility path. In inferred calls, NoInfer prevents concrete inline
// schemas from widening to TSchema to escape result checking.
export function definePortableTool<
  TParams extends TSchema,
  TResult extends PortableToolResult<unknown>,
  TTool extends { outputSchema?: TSchema | undefined } = PortableTool<TParams, TResult>,
>(
  tool: PortableTool<TParams, TResult> &
    TTool &
    (TSchema extends NonNullable<NoInfer<TTool>["outputSchema"]> ? unknown : never),
): TTool;
export function definePortableTool(tool: PortableTool): PortableTool {
  return tool;
}
