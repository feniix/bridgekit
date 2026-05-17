export function signalFromExtra(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== "object" || !("signal" in extra)) {
    return undefined;
  }
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
