import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Check, Errors, Pointer } from "typebox/value";
import type {
  PortableTool,
  PortableToolBuiltInHost,
  PortableToolContext,
  PortableToolResult,
  PortableValidationError,
} from "./define-tool.js";

const ROOT_FIELD = "(root)";

function fieldFromPath(instancePath: string): string {
  return instancePath.split("/").filter(Boolean).at(-1) ?? ROOT_FIELD;
}

/**
 * Resolve the leaf field name of an instancePath against the actual schema.
 *
 * TypeBox does not escape `/` inside property names when building
 * `instancePath` (it does not follow JSON Pointer RFC 6901's `~1` encoding),
 * so a property literally named `a/b` produces `instancePath: "/a/b"`. The
 * string-split fallback (`fieldFromPath`) would then surface `"b"` and lose
 * the prefix. This helper walks the schema greedily — at each object node it
 * matches the longest prefix of remaining path segments that names a real
 * property key, descending into the matched sub-schema — and returns the
 * actual leaf key. Array nodes consume a single numeric segment via `items`.
 *
 * Returns `undefined` if the walk gets stuck (the schema does not model the
 * data path — e.g. `additionalProperties` content). The caller then falls
 * back to the string-split `fieldFromPath`, preserving prior behavior.
 *
 * The `required` and `additionalProperties` callers already read structured
 * `params` and are unaffected; this helper covers the `const` / `enum` /
 * default keyword branches.
 */
function fieldFromSchemaWalk(schema: TSchema, instancePath: string): string | undefined {
  if (instancePath === "") return undefined;
  const segments = instancePath.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  let current: unknown = schema;
  let lastKey: string | undefined;
  let i = 0;
  while (i < segments.length) {
    if (!current || typeof current !== "object") return undefined;
    const node = current as { properties?: Record<string, unknown>; items?: unknown };
    // Array descent: numeric segment against an `items` schema. Tuple-form
    // `items` (array) indexes positionally; schema-form descends uniformly.
    if (node.items !== undefined && /^\d+$/.test(segments[i])) {
      const idx = Number(segments[i]);
      if (Array.isArray(node.items)) {
        if (idx >= node.items.length) return undefined;
        current = node.items[idx];
      } else {
        current = node.items;
      }
      lastKey = segments[i];
      i++;
      continue;
    }
    // Object descent: greedy longest-prefix match against `properties` keys.
    // This is what lets `a/b` resolve to a single key when the schema
    // declares it, even though the instancePath segments it as ["a", "b"].
    if (node.properties && typeof node.properties === "object") {
      const props = node.properties;
      let matched = -1;
      for (let j = segments.length; j > i; j--) {
        const candidate = segments.slice(i, j).join("/");
        if (Object.hasOwn(props, candidate)) {
          matched = j;
          lastKey = candidate;
          current = props[candidate];
          break;
        }
      }
      if (matched === -1) return undefined;
      i = matched;
      continue;
    }
    return undefined;
  }
  return lastKey;
}

function fieldFromError(schema: TSchema, error: TLocalizedValidationError): string {
  return fieldFromSchemaWalk(schema, error.instancePath) ?? fieldFromPath(error.instancePath);
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
      current = obj.properties[segment];
      if (current === undefined) return undefined;
      continue;
    }
    if (obj.items !== undefined && /^\d+$/.test(segment)) {
      if (Array.isArray(obj.items)) {
        const idx = Number(segment);
        if (idx >= obj.items.length) return undefined;
        current = obj.items[idx];
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
    const matchedIndices: number[] = [];
    for (let i = 0; i < branches.length; i++) {
      if (branchDiscriminatorMatches(branches[i], branchValue)) matchedIndices.push(i);
    }
    if (matchedIndices.length !== 1) {
      resolutions.set(path, { kind: "no-active" });
      continue;
    }
    const activeIndex = matchedIndices[0];
    const active = branches[activeIndex];
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
      for (const [key, propSchema] of Object.entries(branches[i].properties ?? {})) {
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
    .flatMap((error) => expandTypeBoxError(tool.parameters, error))
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
