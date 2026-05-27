import { definePortableTool } from "@feniix/bridgekit";
import { type PiToolRegistration, registerPiTools } from "@feniix/bridgekit/pi";
import type { TSchema } from "typebox";
import { Type } from "typebox";

const validTool = definePortableTool({
  name: "valid",
  title: "Valid",
  description: "A valid tool for pi registration.",
  parameters: Type.Object({ text: Type.String() }),
  execute(args) {
    return { text: args.text };
  },
});

const validPi = {
  registerTool(_tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
      ctx?: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }) {},
};

registerPiTools(validPi, [validTool]);

const piMissingRegisterTool = {} as Record<string, unknown>;
// @ts-expect-error pi registration target must expose `registerTool`.
registerPiTools(piMissingRegisterTool, [validTool]);

// Adversarial pin (0.13.0, #60): the tool object bridgekit constructs
// internally and hands to `pi.registerTool` must be assignable to a tool
// shape whose `promptGuidelines` is a MUTABLE `string[]` — i.e., the shape
// pi-coding-agent's `ExtensionAPI` actually accepts. Pre-0.13.0 bridgekit
// declared `readonly string[]` on its own `PiToolDefinition.promptGuidelines`,
// and `readonly string[]` is not assignable to `string[]`. 0.13.0 widens
// bridgekit's internal type to `string[]` to match what the runtime has
// actually been doing since 0.9.1 (spread-copy at the boundary).
//
// We probe this directly: extract `PiToolDefinition` as the parameter type of
// `PiToolRegistration.registerTool`, and assert it satisfies a shape with
// `promptGuidelines: string[]`. This bypasses method-bivariance quirks that
// would mask the gap when comparing whole registry types.
type ExtensionApiToolInput = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
  promptSnippet?: string;
  // Mutable, matching pi-coding-agent's ExtensionAPI tool input.
  promptGuidelines?: string[];
};

type BridgekitToolInput = Parameters<PiToolRegistration["registerTool"]>[0];

// Compile-time pin. Directly assigns a `BridgekitToolInput` value to the
// `ExtensionApiToolInput` slot — the question the contravariance gap
// actually answers. If `PiToolDefinition.promptGuidelines` reverts to
// `readonly string[]`, `readonly string[]` is not assignable to `string[]`
// and this declaration fails to compile.
declare const __bridgekitToolValue__: BridgekitToolInput;
const __piToolAssignmentPin__: ExtensionApiToolInput = __bridgekitToolValue__;
// Reference so the declaration is not flagged unused.
void __piToolAssignmentPin__;

// Smoke check at the registerPiTools call site too. The variable name
// matches the consumer code shape; if the contravariance gap reopens, the
// direct assignment above is the load-bearing failure; this line continues
// to pass under method-bivariance regardless.
declare const extensionApi: { registerTool: (tool: ExtensionApiToolInput) => unknown };
registerPiTools(extensionApi, [validTool]);
