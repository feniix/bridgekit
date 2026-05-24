/**
 * Defensively pulls an `AbortSignal` out of MCP request `extra`. The MCP SDK
 * does not formally type a `signal` on `extra`, so the shape is sniffed
 * structurally.
 *
 * Validated against `@modelcontextprotocol/sdk` v1.x. Revalidate on any SDK
 * major bump in case the cancellation channel moves or gains a typed surface.
 */
export function signalFromExtra(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object" || !("signal" in extra)) {
    return undefined;
  }
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
