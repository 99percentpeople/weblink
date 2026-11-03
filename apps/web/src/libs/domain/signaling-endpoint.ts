/** Empty selects the deployment default. Keep routing paths and tenant queries intact. */
export function parseSignalingOverride(
  input: string,
  securePage = typeof location !== "undefined" &&
    location.protocol === "https:",
): string | null {
  const value = input.trim();
  if (!value) return "";
  if (
    !/^wss?:\/\/[^/?#]/i.test(value) ||
    /[\s\\#]/.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.searchParams.has("room") ||
      url.searchParams.has("pwd")
    )
      return null;
    const loopback =
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (securePage && url.protocol === "ws:" && !loopback)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
