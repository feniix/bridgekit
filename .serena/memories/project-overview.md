# BridgeKit — project overview

`@feniix/bridgekit` is a small ESM-only TypeScript library that lets you define a tool **once** (host-neutral, TypeBox-typed) and expose the same implementation through multiple hosts. Currently ships adapters for **pi** and **MCP**; custom hosts are opt-in via generics.

- Package name: `@feniix/bridgekit` (version per `package.json`)
- Node: `>=22.19.0`, ESM-only, `sideEffects: false`
- Repo: https://github.com/feniix/bridgekit
- License: MIT

## Three public entrypoints (do not deep-import)
- `@feniix/bridgekit` — host-neutral core (define / validate / execute)
- `@feniix/bridgekit/pi` — pi adapter only
- `@feniix/bridgekit/mcp` — MCP server adapter only

Each entrypoint maps to its own compiled file under `dist/src/`. Splitting these three keeps pi-only consumers from pulling the MCP SDK (and vice versa).

## Why this exists
A tool author writes one host-neutral module (no pi imports, no MCP SDK imports), then any consumer adapter registers it for its host. TypeBox schemas double as runtime validation and as MCP JSON Schema (no conversion step).
