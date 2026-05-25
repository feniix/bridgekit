# Tech Stack — @feniix/bridgekit

- Language: TypeScript (source), emitted ESM JS to `dist/src/**`. `type: "module"`.
- Build: `tsc -b tsconfig.json` only — no bundler. `sourceMap: false` (enforced by smoke test).
- Module resolution: NodeNext. Internal imports use `.js` extension on `.ts` source.
- Runtime target: Node `>=22.19.0` (`engines.node`). Uses built-in `node --test`.
- Package manager: npm (no `workspace:`/`file:` ranges; smoke test rejects them).
- Lint/format: Biome `2.4.10` only. Config: `biome.json`. Two-space indent, 120-col, double quotes, semicolons. Enforced rules of note: `noExplicitAny`, `noNonNullAssertion`, `noUnusedImports`.

## Dependencies (runtime)

- `@modelcontextprotocol/sdk ^1.29.0` — pulled only by `./mcp` entrypoint.
- `typebox ^1.1.31` — `Type.Object(...)` is the required tool-schema shape.

## Dev deps

- `typescript ^5.5.0`
- `@types/node ^22.19.17`
- `@total-typescript/shoehorn ^0.1.2` — used in tests for type narrowing instead of `as` casts.
- `@biomejs/biome 2.4.10`.

## Published surface

- `exports`: `.`, `./pi`, `./mcp`, `./package.json`. No others.
- `files`: `dist/**/*.js`, `dist/**/*.d.ts`, excluding `*.test.*`, `*.typecheck.*`, `*.map`, `dist/tsconfig.tsbuildinfo`. Plus `README.md`, `llms.txt`, `examples/README.md`.
- `main`/`types`: `dist/src/index.{js,d.ts}`.
- `sideEffects: false`.

Per-check enforcement of the above lives in `docs/packaging-invariants.md` and `scripts/smoke-package.mjs`.
