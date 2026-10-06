import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./adapter.mjs";

if (process.argv.includes("--direct")) {
  await buildServer().connect(new StdioServerTransport());
} else {
  serveStdio(buildServer, {
    legacy: process.argv.includes("--strict") ? "reject" : "serve",
  });
}
