// Compile-only fixture. Locks in:
//   1. The native (`pi`, `mcp`) host-extras shapes at the public surface.
//   2. The module-augmentation contract — custom host adapters extend
//      `PortableToolHostExtras` via TypeScript's declaration merging so a
//      tool can carry per-host metadata for hosts bridgekit doesn't know
//      about natively. The augmentation lives in this same file; without it
//      `hostExtras["custom-runtime"]` would be a type error.
//
// IMPORTANT: the `declare module "@feniix/bridgekit"` block below augments
// the package interface for the entire `tsc -b` program — not just this
// file. Adding another `*.typecheck.ts` fixture that re-declares the
// `"custom-runtime"` namespace (or any other previously-claimed key) will
// produce a duplicate-declaration error at the program level. Future
// negative-case fixtures must use distinct namespace names.
//
// Excluded from `npm test` (`*.typecheck.ts` glob) and from the published
// tarball (`package.json#files`).

import {
  definePortableTool,
  type PiToolCallRenderer,
  type PiToolResultRenderer,
  type PortableToolHostExtras,
} from "@feniix/bridgekit";
import { Type } from "typebox";

// Module augmentation: declare a custom host namespace alongside the built-in
// ones. The `declare module "@feniix/bridgekit"` form is the public contract
// for downstream consumers wiring their own adapters.
declare module "@feniix/bridgekit" {
  interface PortableToolHostExtras {
    "custom-runtime"?: { something: string };
  }
}

const params = Type.Object({ text: Type.String() });

const renderCall: PiToolCallRenderer = (
  args: { text: string },
  theme: { accent: string },
  context: { id: string },
) => ({
  args,
  theme,
  context,
});
const renderResult: PiToolResultRenderer = (
  result: { content: Array<{ type: "text"; text: string }> },
  options: { expanded: boolean },
  theme: { accent: string },
  context: { id: string },
) => ({ result, options, theme, context });

// Native pi extras — every documented field exercised at the call site so a
// rename or removal surfaces here.
const piTool = definePortableTool({
  name: "pi_extras",
  title: "Pi Extras",
  description: "Typecheck fixture for hostExtras.pi.",
  parameters: params,
  execute(args) {
    return { text: args.text };
  },
  hostExtras: {
    pi: {
      pendingMessage: "Processing...",
      promptSnippet: "Use this tool to echo text.",
      promptGuidelines: ["Prefer concise text.", "Do not exceed 100 chars."] as const,
      renderCall,
      renderResult,
    },
  },
});

// Native mcp extras — every annotation field exercised so a future SDK shape
// change reaches this fixture before reaching consumers.
const mcpTool = definePortableTool({
  name: "mcp_extras",
  title: "MCP Extras",
  description: "Typecheck fixture for hostExtras.mcp.",
  parameters: params,
  execute(args) {
    return { text: args.text };
  },
  hostExtras: {
    mcp: {
      annotations: {
        title: "MCP Extras",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  },
});

// Module-augmentation positive case: a tool sets the custom-host slot
// declared above. If the augmentation broke, this assignment would fail.
const customTool = definePortableTool({
  name: "custom_extras",
  title: "Custom Extras",
  description: "Typecheck fixture for module-augmented hostExtras.",
  parameters: params,
  execute(args) {
    return { text: args.text };
  },
  hostExtras: {
    "custom-runtime": { something: "x" },
  },
});

// Surface the type at the value position so it's reachable from this file's
// type graph without needing a runtime export. The interface has no runtime
// footprint, so consumers can only verify its shape at compile time.
const extras: PortableToolHostExtras = {
  pi: { pendingMessage: "x", renderCall, renderResult },
  mcp: { annotations: { readOnlyHint: true } },
  "custom-runtime": { something: "y" },
};

void piTool;
void mcpTool;
void customTool;
void extras;
