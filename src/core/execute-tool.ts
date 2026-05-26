import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Check, Errors } from "typebox/value";
import type {
  PortableTool,
  PortableToolBuiltInHost,
  PortableToolContext,
  PortableToolResult,
  PortableValidationError,
} from "./define-tool.js";

const ROOT_FIELD = "(root)";

/**
 * JSON-Schema-shaped record describing a Union branch as TypeBox emits it.
 * We deliberately keep this loose (no TypeBox internals like the `Kind`
 * symbol) so the helper stays robust across minor TypeBox upgrades — the
 * compiled output is canonical JSON Schema by the time we read it.
 */
type UnionObjectBranch = {
  type?: string;
  properties?: Record<string, { const?: unknown; enum?: unknown[] } | undefined>;
  required?: string[];
};

type UnionSchemaShape = {
  anyOf?: UnionObjectBranch[];
  oneOf?: UnionObjectBranch[];
};

function resolveSchemaAtPath(schema: TSchema, instancePath: string): unknown {
  // Walk a JSON-pointer-style instancePath (e.g. "/event") down through
  // Object schemas to land on the sub-schema at that data path. We only
  // follow `properties` — array index segments and other JSON Schema
  // composites bail out and return undefined; the caller then falls back
  // to the conservative suppress-all rule.
  if (instancePath === "") return schema;
  const segments = instancePath.split("/").filter(Boolean);
  let current: unknown = schema;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    const obj = current as { properties?: Record<string, unknown> };
    if (!obj.properties || typeof obj.properties !== "object") return undefined;
    current = obj.properties[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

function readUnionBranches(node: unknown): UnionObjectBranch[] | undefined {
  // Accept both `anyOf` and `oneOf`. Each branch must be a plain object
  // schema for this helper to apply — primitive unions (e.g. `Union([
  // Literal("a"), Literal("b")])` rendered as anyOf-of-consts) have no
  // discriminator-prop concept and the caller falls back.
  if (!node || typeof node !== "object") return undefined;
  const shape = node as UnionSchemaShape;
  const branches = shape.anyOf ?? shape.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  if (!branches.every((b) => b && typeof b === "object" && b.type === "object" && b.properties)) {
    return undefined;
  }
  return branches;
}

function readValueAtPath(value: unknown, instancePath: string): unknown {
  if (instancePath === "") return value;
  const segments = instancePath.split("/").filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function branchDiscriminatorMatches(
  branch: UnionObjectBranch,
  value: unknown,
): { hasDiscriminator: boolean; matches: boolean } {
  // A discriminator prop on a branch is a property whose schema is a
  // single `const` literal or an `enum` set. Other props don't act as
  // discriminators for this rule — we want only the "picked a tag"
  // pattern, not "all string types coincidentally match this branch".
  if (!value || typeof value !== "object") return { hasDiscriminator: false, matches: false };
  const input = value as Record<string, unknown>;
  let hasDiscriminator = false;
  for (const [key, propSchema] of Object.entries(branch.properties ?? {})) {
    if (!propSchema || typeof propSchema !== "object") continue;
    if ("const" in propSchema) {
      hasDiscriminator = true;
      if (!(key in input) || input[key] !== propSchema.const) return { hasDiscriminator, matches: false };
      continue;
    }
    if (Array.isArray(propSchema.enum)) {
      hasDiscriminator = true;
      if (!(key in input) || !propSchema.enum.includes(input[key])) return { hasDiscriminator, matches: false };
    }
  }
  return { hasDiscriminator, matches: hasDiscriminator };
}

function isSubsetOf(props: readonly string[], set: ReadonlySet<string>): boolean {
  for (const p of props) if (!set.has(p)) return false;
  return true;
}

function suppressSiblingErrorsUnderUnion(
  schema: TSchema,
  value: unknown,
  errors: TLocalizedValidationError[],
): TLocalizedValidationError[] {
  // For unions of objects, TypeBox emits per-branch `required` /
  // `additionalProperties` errors at the union's path. The user only needs
  // to satisfy ONE branch, so those entries are phantoms; the `anyOf` /
  // `oneOf` summary at the same path is the real signal.
  //
  // `const` / `enum` errors at the same path survive — they carry real
  // discriminator info about which branch was intended.
  //
  // Discriminated-union refinement (#38): when an `anyOf`/`oneOf` fires at
  // path P and exactly one branch's discriminator props (`const` / `enum`)
  // are satisfied by the input, that branch is "active". Required and
  // additionalProperties errors attributable to the active branch are
  // preserved (so the user sees "you picked op=create, missing name");
  // contributions from losing branches at P and its descendants are
  // suppressed. Schema-walking on the public JSON-Schema shape avoids
  // depending on TypeBox internals.
  //
  // Fallback: zero or multiple branches match — there is no actionable
  // owner for the phantom errors, so the conservative 0.8.1 rule applies
  // (drop all sibling `required` / `additionalProperties` at P, keep
  // const / enum). This covers non-discriminated unions and ambiguous
  // inputs.
  const unionPaths = new Set<string>();
  for (const error of errors) {
    if (error.keyword === "anyOf" || error.keyword === "oneOf") {
      unionPaths.add(error.instancePath);
    }
  }
  if (unionPaths.size === 0) return errors;

  // Resolve each union path to (active branch | "no-active") in one pass.
  type Resolution =
    | { kind: "no-active" }
    | {
        kind: "active";
        branchRequired: Set<string>;
        branchProps: Set<string>;
        losingDiscriminators: Map<string, Set<unknown>>;
      };
  const resolutions = new Map<string, Resolution>();
  for (const path of unionPaths) {
    const unionSchema = resolveSchemaAtPath(schema, path);
    const branches = readUnionBranches(unionSchema);
    if (!branches) {
      resolutions.set(path, { kind: "no-active" });
      continue;
    }
    const branchValue = readValueAtPath(value, path);
    const matchedIndices: number[] = [];
    for (let i = 0; i < branches.length; i++) {
      const result = branchDiscriminatorMatches(branches[i], branchValue);
      if (result.matches) matchedIndices.push(i);
    }
    if (matchedIndices.length !== 1) {
      resolutions.set(path, { kind: "no-active" });
      continue;
    }
    const activeIndex = matchedIndices[0];
    const active = branches[activeIndex];
    const branchRequired = new Set(active.required ?? []);
    const branchProps = new Set(Object.keys(active.properties ?? {}));
    // Map of property-name -> set of disallowed const values held by losing
    // branches' discriminators. Used to drop "must equal X" errors at the
    // union's descendant paths when X belongs to a branch the user didn't
    // pick. Schema-walking here is cleaner than parsing error provenance.
    const losingDiscriminators = new Map<string, Set<unknown>>();
    for (let i = 0; i < branches.length; i++) {
      if (i === activeIndex) continue;
      for (const [key, propSchema] of Object.entries(branches[i].properties ?? {})) {
        if (!propSchema || typeof propSchema !== "object") continue;
        const values: unknown[] = [];
        if ("const" in propSchema) values.push(propSchema.const);
        if (Array.isArray(propSchema.enum)) values.push(...propSchema.enum);
        if (values.length === 0) continue;
        let existing = losingDiscriminators.get(key);
        if (!existing) {
          existing = new Set();
          losingDiscriminators.set(key, existing);
        }
        for (const v of values) existing.add(v);
      }
    }
    resolutions.set(path, { kind: "active", branchRequired, branchProps, losingDiscriminators });
  }

  return errors.filter((error) => {
    // Errors at a union path: handle by keyword + active-branch attribution.
    const resolution = resolutions.get(error.instancePath);
    if (resolution) {
      if (resolution.kind === "no-active") {
        // 0.8.1 fallback: drop required/additionalProperties at P; keep
        // const / enum / anyOf (they carry discriminator info the user
        // needs to fix the input).
        return error.keyword !== "required" && error.keyword !== "additionalProperties";
      }
      // Active branch resolved: suppress the anyOf/oneOf summary at P too.
      // The active branch's specific errors (preserved below) are strictly
      // more actionable than "must match a schema in anyOf".
      if (error.keyword === "anyOf" || error.keyword === "oneOf") return false;
      if (error.keyword === "required") {
        // Attribute by structured params: the active branch demanded a
        // superset of these props iff the missing props are all in its
        // `required` array. Other branches' `required` entries get dropped.
        const props = error.params.requiredProperties ?? [];
        return props.length > 0 && isSubsetOf(props, resolution.branchRequired);
      }
      if (error.keyword === "additionalProperties") {
        // The active-branch's additionalProperties error lists ONLY keys
        // genuinely missing from its `properties` map. A losing branch may
        // include the active branch's legitimate props in its list (because
        // it has its own, narrower property set), so we keep only errors
        // where EVERY offending key is also additional for the active
        // branch. Losing-branch entries that drag in active-branch props
        // get dropped — they would expand into phantom "name is additional"
        // entries otherwise.
        const props = error.params.additionalProperties ?? [];
        return props.length > 0 && props.every((p) => !resolution.branchProps.has(p));
      }
      return true;
    }
    // Errors at descendant paths of a union path: when an active branch is
    // resolved at the parent, drop `const`/`enum` errors whose allowedValue
    // belongs to a losing branch's discriminator at this prop. This keeps
    // the active-branch error story coherent ("you picked create, forgot
    // name") instead of mixing in "could also have been delete" noise.
    if (error.keyword !== "const" && error.keyword !== "enum") return true;
    for (const [unionPath, resolution] of resolutions) {
      if (resolution.kind !== "active") continue;
      const prefix = unionPath === "" ? "/" : `${unionPath}/`;
      if (!error.instancePath.startsWith(prefix)) continue;
      const remainder = error.instancePath.slice(prefix.length);
      if (remainder.includes("/")) continue; // only direct discriminator props
      const losingValues = resolution.losingDiscriminators.get(remainder);
      if (!losingValues) continue;
      if (error.keyword === "const" && losingValues.has(error.params.allowedValue)) return false;
      if (error.keyword === "enum" && Array.isArray(error.params.allowedValues)) {
        if (error.params.allowedValues.every((v) => losingValues.has(v))) return false;
      }
    }
    return true;
  });
}

function expandTypeBoxError(error: TLocalizedValidationError): PortableValidationError[] {
  // Read offending property names from TypeBox's structured `params` rather
  // than parsing the message string. Two payoffs: locale independence (the
  // helper works the same after `Locale.Set("de_DE")`), and faithful
  // preservation of property names that contain delimiters TypeBox's prose
  // would split on (commas, etc.).
  if (error.keyword === "required") {
    const props = error.params.requiredProperties.filter((p) => p.length > 0);
    if (props.length > 0) {
      return props.map((field) => ({
        field,
        message: `must have required property ${field}`,
      }));
    }
  }
  if (error.keyword === "additionalProperties") {
    const props = error.params.additionalProperties.filter((p) => p.length > 0);
    if (props.length > 0) {
      return props.map((field) => ({
        field,
        message: `must not have additional property ${field}`,
      }));
    }
  }

  const segments = error.instancePath.split("/").filter(Boolean);
  return [{ field: segments.at(-1) ?? ROOT_FIELD, message: error.message }];
}

export function validatePortableToolArgs<THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TSchema, THost>,
  args: unknown,
): { ok: true } | { ok: false; errors: PortableValidationError[] } {
  if (Check(tool.parameters, args)) {
    return { ok: true };
  }

  // TypeBox can emit multiple errors per offending field (e.g. union/anyOf
  // mismatches fire one error per failed branch). First, when an anyOf/oneOf
  // error fires at a path, drop sibling `required`/`additionalProperties`
  // errors at the same path — they're phantoms (the consumer only needs to
  // satisfy ONE branch, not all of them). Then dedupe the survivors by
  // (field, message) using JSON.stringify so the key can't collide regardless
  // of what characters field or message contain.
  const rawErrors = suppressSiblingErrorsUnderUnion(tool.parameters, args, [
    ...Errors(tool.parameters, args),
  ] as TLocalizedValidationError[]);
  const seen = new Set<string>();
  const errors = rawErrors
    .flatMap((error) => expandTypeBoxError(error))
    .filter(({ field, message }) => {
      const key = JSON.stringify([field, message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { ok: false, errors };
}

export async function executePortableTool<THost extends string = PortableToolBuiltInHost>(
  tool: PortableTool<TSchema, THost>,
  args: unknown,
  ctx: PortableToolContext<NoInfer<THost>>,
): Promise<PortableToolResult> {
  const validation = validatePortableToolArgs(tool, args);
  if (!validation.ok) {
    return {
      text: `Invalid arguments for ${tool.name}: ${validation.errors
        .map((error) => `${error.field}: ${error.message}`)
        .join("; ")}`,
      structuredContent: {
        kind: "validation",
        tool: tool.name,
        validationErrors: validation.errors,
      },
      isError: true,
    };
  }

  return tool.execute(args as never, ctx);
}
