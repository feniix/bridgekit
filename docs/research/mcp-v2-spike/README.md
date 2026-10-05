# Isolated MCP SDK v2 spike

These files exercise BridgeKit's public portable execution API against SDK v2,
without changing the repository's production dependencies.

Run from the BridgeKit repository root (requires npm registry access):

```bash
npm run build
repo="$PWD"
spike="$(mktemp -d)"
cp docs/research/mcp-v2-spike/*.mts "$spike/"
cd "$spike"
npm init -y
npm install --ignore-scripts --save-exact \
  @modelcontextprotocol/server@2.3.1 @modelcontextprotocol/client@2.3.1 \
  @modelcontextprotocol/sdk@1.30.1 typebox@1.1.31 \
  typescript@6.0.3 @types/node@25.9.1
mkdir -p node_modules/@feniix
ln -s "$repo" node_modules/@feniix/bridgekit
./node_modules/.bin/tsc --module nodenext --target es2024 --types node \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --outDir dist adapter.mts server.mts spike.test.mts
node --test dist/spike.test.mjs
```

The array tool is an SDK-only fixture: current portable results are object-shaped.
The adapter is deliberately minimal and does not replace BridgeKit's complete
schema guards, error handling, or lifecycle behavior.

Results and remaining migration decisions:
[MCP protocol research](../mcp-protocol-v2.md#verified-code-spike--2026-10-05).
