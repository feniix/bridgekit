import { definePortableTool } from "@feniix/bridgekit";
import { registerPiTools } from "@feniix/bridgekit/pi";
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
