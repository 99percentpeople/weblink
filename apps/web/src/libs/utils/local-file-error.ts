/** Local file diagnostics only. Remote/server errors still use the translated error boundary. */
export function localFileErrorDetail(
  error: unknown,
): string | undefined {
  const seen = new Set<unknown>();
  const lines: string[] = [];
  for (let depth = 0; error != null && depth < 5; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    if (typeof error === "string") {
      if (error.trim()) lines.push(error.trim());
      break;
    }
    if (typeof error !== "object") break;
    const value = error as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const name =
      typeof value.name === "string"
        ? value.name.trim()
        : "";
    if (
      typeof value.message === "string" &&
      value.message.trim()
    ) {
      const message = value.message.trim();
      lines.push(name ? `${name}: ${message}` : message);
    } else if (name && name !== "Error") lines.push(name);
    error = value.cause;
  }
  return [...new Set(lines)].join("\n") || undefined;
}
