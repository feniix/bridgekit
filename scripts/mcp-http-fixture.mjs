// Loopback-only research fixture. Not a production HTTP security recipe.
import { createServer } from "node:http";
import { definePortableTool } from "@feniix/bridgekit";
import { createMcpHttpHandler } from "@feniix/bridgekit/mcp";
import { Type } from "typebox";

const handler = createMcpHttpHandler({
  name: "bridgekit-http-fixture",
  version: "0.0.0",
  tools: [
    definePortableTool({
      name: "test_simple_text",
      title: "Simple text",
      description: "Conformance simple text fixture",
      parameters: Type.Object({}),
      execute: () => ({ text: "This is a simple text response for testing." }),
    }),
    definePortableTool({
      name: "test_error_handling",
      title: "Error",
      description: "Conformance expected error fixture",
      parameters: Type.Object({}),
      execute: () => {
        throw new Error("This tool intentionally returns an error for testing");
      },
    }),
    definePortableTool({
      name: "echo",
      title: "Echo",
      description: "Echo text",
      parameters: Type.Object({ text: Type.String() }),
      outputSchema: Type.Object({ text: Type.String() }),
      execute: (args) => ({ text: args.text, structuredContent: { text: args.text } }),
    }),
  ],
});
const listener = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const method = incoming.method ?? "GET";
    const response = await handler.fetch(
      new Request(`http://127.0.0.1${incoming.url}`, {
        method,
        headers,
        ...(method === "POST" && { body: Buffer.concat(chunks).toString() }),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) outgoing.write(chunk);
    }
    outgoing.end();
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});
listener.listen(0, "127.0.0.1", () => {
  const address = listener.address();
  if (address && typeof address !== "string") console.log(`http://127.0.0.1:${address.port}/mcp`);
});
const close = async () => {
  await handler.close();
  listener.closeAllConnections();
  listener.close();
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
