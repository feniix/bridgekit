import assert from "node:assert/strict";
import test from "node:test";
import {
  definePortableTool,
  executePortableTool,
  isDomainFailure,
  isValidationFailure,
  type PortableToolResult,
  type PortableValidationError,
} from "@feniix/bridgekit";
import { Type } from "typebox";

const echoParams = Type.Object({
  text: Type.String({ description: "Text to echo." }),
});

test("isValidationFailure narrows results produced by executePortableTool on TypeBox failure", async () => {
  const tool = definePortableTool({
    name: "validation_guard_test",
    title: "Validation Guard Test",
    description: "Triggers validation failure.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
  });

  const result = await executePortableTool(tool, { text: 42 }, { host: "test" });

  assert.equal(result.isError, true);
  assert.equal(isValidationFailure(result), true);
  if (isValidationFailure(result)) {
    // structuredContent narrowed to the validation shape.
    const tool: string = result.structuredContent.tool;
    const errors: PortableValidationError[] = result.structuredContent.validationErrors;
    assert.equal(tool, "validation_guard_test");
    assert.ok(Array.isArray(errors));
    assert.equal(errors.at(0)?.field, "text");
  }
  // Validation failures are not domain failures.
  assert.equal(isDomainFailure(result), false);
});

test("isValidationFailure returns false for success results", () => {
  const result: PortableToolResult = { text: "ok", structuredContent: { echoed: "ok" } };
  assert.equal(isValidationFailure(result), false);
  assert.equal(isDomainFailure(result), false);
});

test("isValidationFailure returns false for handler-emitted isError results that are not validation-shaped", () => {
  const result: PortableToolResult = {
    text: "domain failure",
    structuredContent: { reason: "intentional" },
    isError: true,
  };
  assert.equal(isValidationFailure(result), false);
});

test("isValidationFailure rejects malformed validationErrors entries", () => {
  const result: PortableToolResult = {
    text: "bad validation-shaped payload",
    structuredContent: {
      kind: "validation",
      tool: "handler_tool",
      validationErrors: [{ field: "text" }],
    },
    isError: true,
  };

  assert.equal(isValidationFailure(result), false);
  assert.equal(isDomainFailure(result), true);
});

test("isDomainFailure narrows handler-emitted isError results", () => {
  const result: PortableToolResult = {
    text: "domain failure",
    structuredContent: { reason: "intentional" },
    isError: true,
  };
  assert.equal(isDomainFailure(result), true);
  if (isDomainFailure(result)) {
    assert.deepEqual(result.structuredContent, { reason: "intentional" });
  }
});

test("isDomainFailure returns false for success results and for validation failures", async () => {
  const successResult: PortableToolResult = { text: "ok" };
  assert.equal(isDomainFailure(successResult), false);

  const tool = definePortableTool({
    name: "validation_guard_negative",
    title: "Validation Guard Negative",
    description: "Triggers validation failure.",
    parameters: echoParams,
    execute(args) {
      return { text: args.text };
    },
  });
  const validationResult = await executePortableTool(tool, { text: 42 }, { host: "test" });
  assert.equal(isDomainFailure(validationResult), false);
});

test("isDomainFailure handles handler-emitted isError results without structuredContent", () => {
  const result: PortableToolResult = { text: "raw failure", isError: true };
  assert.equal(isDomainFailure(result), true);
  assert.equal(isValidationFailure(result), false);
});
