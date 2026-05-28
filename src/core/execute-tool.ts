import type { Static, TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Check, Errors, Pointer } from "typebox/value";
import type { PortableTool, PortableToolContext, PortableToolResult, PortableValidationError } from "./define-tool.js";
import type { PortableValidationFailure } from "./result-guards.js";

const ROOT_FIELD = "(root)";

type PortableToolSuccess<TResult extends PortableToolResult> = TResult & {
  details?: Record<string, unknown>;
  isError?: boolean;
} & (TResult extends { structuredContent?: infer TStructured }
    ? { structuredContent?: TStructured }
    : { structuredContent?: Record<string, unknown> });

function fieldFromPath(instancePath: string): string {
  return instancePath.split("/").filter(Boolean).at(-1) ?? ROOT_FIELD;
}

/**
 * Resolve the leaf property name from a TypeBox error by walking
 * `error.schemaPath` rather than `error.instancePath`.
 *
 * `instancePath` does not escape `/` inside property names (TypeBox does not
 * follow JSON Pointer RFC 6901's `~1` encoding), so a schema with BOTH a
 * slash-named property `"a/b"` AND a nested path `a.b` produces the same
 * `instancePath: "/a/b"` for either failure — the two cases are
 * indistinguishable from the data path alone. `schemaPath` carries explicit
 * `/properties/` markers per nesting level, so the two cases become
 * structurally distinct:
 *
 *   slash-named `"a/b": Type.String()` wrong type → `#/properties/a/b`
 *   nested `a: Object({ b: Number() })` wrong type → `#/properties/a/properties/b`
 *
 * TypeBox's schemaPath terminates at the violated property's value-schema —
 * it does NOT append the keyword as a trailing segment (the keyword lives in
 * `error.keyword` instead). The walker therefore only needs to consume
 * structural commands (`properties`, `items`, `allOf`) and the property /
 * branch tokens that follow them.
 *
 * `allOf` descent (the 0.9.0 Intersect support) is preserved: an
 * `#/allOf/<i>/properties/<key>` path descends into the i-th branch before
 * resolving the property. `anyOf` / `oneOf` descent is symmetric: TypeBox
 * emits per-branch errors with schemaPath `.../anyOf/<i>/...` (or `.../oneOf/<i>/...`)
 * when a Union (or hand-authored oneOf) sits under a property; the walker
 * descends into the indexed branch carrying `lastField` through so a
 * slash-named property holding a `Type.Union(...)` value preserves its
 * prefix.
 *
 * Returns `undefined` if the walk cannot model the schemaPath (e.g.
 * `additionalProperties` content whose schemaPath stops at `#`). The caller
 * then falls back to the string-split `fieldFromPath` on `instancePath`,
 * preserving prior behavior. The `required` and `additionalProperties`
 * callers already read structured `params` and are unaffected; this helper
 * covers the `type` / `const` / `enum` / numeric-keyword branches.
 */
function fieldFromSchemaWalk(schema: TSchema, schemaPath: string): string | undefined {
  const raw = schemaPath.startsWith("#") ? schemaPath.slice(1) : schemaPath;
  const segments = raw.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  return walkSegments(schema, segments, 0, undefined);
}

function walkSegments(node: unknown, segments: string[], i: number, lastField: string | undefined): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (i >= segments.length) return lastField;
  const obj = node as {
    properties?: Record<string, unknown>;
    items?: unknown;
    allOf?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  const head = segments[i];
  // `allOf` / `anyOf` / `oneOf` commands: next segment is the branch index.
  // Descend into the chosen branch with the rest of the path. `allOf` covers
  // `Type.Intersect` lowering (0.9.0); `anyOf` covers `Type.Union` (and the
  // hand-authored `oneOf` shape). `lastField` carries through unchanged — a
  // slash-named property whose value is a Union must keep its prefix when
  // the walker descends into a per-branch error.
  if (head === "allOf" && Array.isArray(obj.allOf) && i + 1 < segments.length) {
    const idx = Number(segments[i + 1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.allOf.length) return undefined;
    return walkSegments(obj.allOf[idx], segments, i + 2, lastField);
  }
  if (head === "anyOf" && Array.isArray(obj.anyOf) && i + 1 < segments.length) {
    const idx = Number(segments[i + 1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.anyOf.length) return undefined;
    return walkSegments(obj.anyOf[idx], segments, i + 2, lastField);
  }
  if (head === "oneOf" && Array.isArray(obj.oneOf) && i + 1 < segments.length) {
    const idx = Number(segments[i + 1]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= obj.oneOf.length) return undefined;
    return walkSegments(obj.oneOf[idx], segments, i + 2, lastField);
  }
  // `items` command: array element schema. TypeBox emits a single `items`
  // marker regardless of element index (the data-side index is in
  // instancePath, not schemaPath). Tuple-form `items` (array) is not
  // expected here from TypeBox lowering — schema-form is uniform.
  if (head === "items" && obj.items !== undefined) {
    return walkSegments(obj.items, segments, i + 1, lastField);
  }
  // `properties` command: subsequent segments form the property name (joined
  // by `/` to recover slash-named keys). Consume by greedy longest-prefix
  // match against the parent's actual `properties` keys, then descend.
  if (head === "properties" && obj.properties && typeof obj.properties === "object") {
    const props = obj.properties;
    for (let j = segments.length; j > i + 1; j--) {
      const candidate = segments.slice(i + 1, j).join("/");
      if (Object.hasOwn(props, candidate)) {
        const child = walkSegments(props[candidate], segments, j, candidate);
        if (child !== undefined) return child;
      }
    }
    return undefined;
  }
  return undefined;
}

function fieldFromError(schema: TSchema, error: TLocalizedValidationError): string {
  return fieldFromSchemaWalk(schema, error.schemaPath) ?? fieldFromPath(error.instancePath);
}

/**
 * JSON-Schema-shaped record describing a Union branch as TypeBox emits it.
 * We deliberately keep this loose (no TypeBox internals like the `Kind`
 * symbol) so the helper stays robust across minor TypeBox upgrades — the
 * compiled output is canonical JSON Schema by the time we read it.
 */
type DiscriminatorPropSchema = {
  const?: unknown;
  enum?: unknown[];
  anyOf?: unknown[];
};

type UnionObjectBranch = {
  type?: string;
  properties?: Record<string, DiscriminatorPropSchema | undefined>;
  required?: string[];
};

type UnionSchemaShape = {
  anyOf?: UnionObjectBranch[];
  oneOf?: UnionObjectBranch[];
};

type ActiveUnionBranch = {
  index: number;
  branch: UnionObjectBranch;
};

function readDiscriminatorValues(propSchema: DiscriminatorPropSchema | undefined): unknown[] {
  // Extract the allowed values from a discriminator-eligible prop schema.
  // Recognizes three shapes:
  //   - `Type.Literal("x")` → `{ const: "x" }`
  //   - `Type.String({ enum: ["x", "y"] })` → `{ enum: ["x", "y"] }`
  //   - `Type.Union([Type.Literal("x"), Type.Literal("y")])` →
  //     `{ anyOf: [{ const: "x" }, { const: "y" }] }`
  // The anyOf-of-const case is idiomatic TypeBox and was missed before:
  // without it, a branch declaring its tag as a Union-of-Literals was
  // treated as having no discriminator, silently bailing out of branch
  // matching.
  if (!propSchema || typeof propSchema !== "object") return [];
  if ("const" in propSchema) return [propSchema.const];
  if (Array.isArray(propSchema.enum)) return propSchema.enum;
  if (Array.isArray(propSchema.anyOf) && propSchema.anyOf.length > 0) {
    const consts: unknown[] = [];
    for (const entry of propSchema.anyOf) {
      if (entry && typeof entry === "object" && "const" in entry) {
        consts.push((entry as { const: unknown }).const);
      } else {
        return [];
      }
    }
    return consts;
  }
  return [];
}

function resolveSchemaAtPath(schema: TSchema, instancePath: string): unknown {
  // Walk a JSON-pointer-style instancePath (e.g. "/event", "/events/0")
  // down to the sub-schema at that data path. Follows both `properties`
  // for object schemas and `items` for array schemas (numeric segments
  // descend into the items schema). Other JSON Schema composites bail
  // out; the caller then falls back to the conservative suppress-all rule.
  if (instancePath === "") return schema;
  const segments = instancePath.split("/").filter(Boolean);
  let current: unknown = schema;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    const obj = current as { properties?: Record<string, unknown>; items?: unknown };
    if (obj.properties && typeof obj.properties === "object" && segment in obj.properties) {
      const next = obj.properties[segment];
      if (next === undefined) return undefined;
      current = next;
      continue;
    }
    if (obj.items !== undefined && /^\d+$/.test(segment)) {
      if (Array.isArray(obj.items)) {
        const idx = Number(segment);
        const next = getArrayEntry(obj.items, idx);
        if (next === undefined) return undefined;
        current = next;
      } else {
        current = obj.items;
      }
      continue;
    }
    return undefined;
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

function branchDiscriminatorMatches(branch: UnionObjectBranch, value: unknown): boolean {
  // A branch matches its discriminator when every prop with a discriminator-
  // eligible schema (Literal / enum / anyOf-of-Literal) is present on the
  // input with a value the schema allows. `Object.hasOwn` avoids matching
  // prototype-chain props like `toString`.
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  let hasDiscriminator = false;
  for (const [key, propSchema] of Object.entries(branch.properties ?? {})) {
    const allowed = readDiscriminatorValues(propSchema);
    if (allowed.length === 0) continue;
    hasDiscriminator = true;
    if (!Object.hasOwn(input, key) || !allowed.includes(input[key])) return false;
  }
  return hasDiscriminator;
}

function findActiveUnionBranch(branches: readonly UnionObjectBranch[], value: unknown): ActiveUnionBranch | undefined {
  let match: ActiveUnionBranch | undefined;
  for (const [index, branch] of branches.entries()) {
    if (!branchDiscriminatorMatches(branch, value)) continue;
    if (match !== undefined) return undefined;
    match = { index, branch };
  }
  return match;
}

function isSubsetOf(props: readonly string[], set: ReadonlySet<string>): boolean {
  for (const p of props) if (!set.has(p)) return false;
  return true;
}

function getArrayEntry<T>(entries: readonly T[], index: number): T | undefined {
  return index >= 0 && index < entries.length ? entries[index] : undefined;
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

  // Pre-compute resolutions in one schema-walk pass so the filter callback
  // below reads only decisions, not schema structure.
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
    const branchValue = Pointer.Get(value, path);
    const activeMatch = findActiveUnionBranch(branches, branchValue);
    if (!activeMatch) {
      resolutions.set(path, { kind: "no-active" });
      continue;
    }
    const { branch: active, index: activeIndex } = activeMatch;
    const branchRequired = new Set(active.required ?? []);
    const branchProps = new Set(Object.keys(active.properties ?? {}));
    // Map of property-name -> set of disallowed values held by losing
    // branches' discriminators. Used to drop "must equal X" errors at the
    // union's descendant paths when X belongs to a branch the user didn't
    // pick. Covers `const`, `enum`, and `Union([Literal, Literal])` (the
    // anyOf-of-const shape) via `readDiscriminatorValues`.
    const losingDiscriminators = new Map<string, Set<unknown>>();
    for (let i = 0; i < branches.length; i++) {
      if (i === activeIndex) continue;
      const branch = getArrayEntry(branches, i);
      if (!branch) continue;
      for (const [key, propSchema] of Object.entries(branch.properties ?? {})) {
        const values = readDiscriminatorValues(propSchema);
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

function expandTypeBoxError(schema: TSchema, error: TLocalizedValidationError): PortableValidationError[] {
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
  // const / enum errors carry the allowed values in `params`. Surfacing them
  // in the message lets an agent recovering from an invalid-discriminator
  // failure see exactly what tag(s) are accepted, rather than the opaque
  // `must be equal to constant`.
  if (error.keyword === "const") {
    return [
      {
        field: fieldFromError(schema, error),
        message: `must equal ${JSON.stringify(error.params.allowedValue)}`,
      },
    ];
  }
  if (error.keyword === "enum") {
    const allowed = error.params.allowedValues ?? [];
    return [
      {
        field: fieldFromError(schema, error),
        message:
          allowed.length > 0 ? `must equal one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}` : error.message,
      },
    ];
  }

  return [{ field: fieldFromError(schema, error), message: error.message }];
}

export function validatePortableToolArgs<TParams extends TSchema>(
  tool: PortableTool<TParams>,
  args: unknown,
): { ok: true; args: Static<TParams> } | { ok: false; errors: PortableValidationError[] } {
  if (Check(tool.parameters, args)) {
    return { ok: true, args };
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
    .flatMap((error) => expandTypeBoxError(tool.parameters, error))
    .filter(({ field, message }) => {
      const key = JSON.stringify([field, message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return { ok: false, errors };
}

export async function executePortableTool<TParams extends TSchema, TResult extends PortableToolResult>(
  tool: PortableTool<TParams, TResult>,
  args: unknown,
  ctx: PortableToolContext,
): Promise<PortableToolSuccess<TResult> | PortableValidationFailure> {
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

  return (await tool.execute(validation.args, ctx)) as PortableToolSuccess<TResult>;
}
