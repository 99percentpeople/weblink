export interface RemoteTextEvent {
  type: "text";
  text: string;
}
export const MAX_TEXT_PACKET = 64; // UTF-16 units, matching the native engine.
export const MAX_TEXT_COMMIT = 1024;

export function validRemoteText(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= MAX_TEXT_PACKET &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(text) &&
    Array.from(text).every(
      (char) => !/^[\ud800-\udfff]$/u.test(char),
    )
  );
}

/** Bounded, ordered input; never queue or retry text across a transport reset. */
export function sendRemoteText(
  value: string,
  port: {
    text(value: string): boolean;
    key(code: "Enter" | "Tab"): boolean;
  },
): "sent" | "invalid" | "too-long" | "interrupted" {
  if (value.length > MAX_TEXT_COMMIT) return "too-long";
  const text = value.replace(/\r\n?/g, "\n");
  if (
    !text ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(
      text,
    ) ||
    Array.from(text).some((char) =>
      /^[\ud800-\udfff]$/u.test(char),
    )
  )
    return "invalid";
  let chunk = "";
  const flush = () => {
    if (!chunk) return true;
    const sent = port.text(chunk);
    chunk = "";
    return sent;
  };
  for (const char of text) {
    if (char === "\n" || char === "\t") {
      if (
        !flush() ||
        !port.key(char === "\n" ? "Enter" : "Tab")
      )
        return "interrupted";
    } else {
      if (
        chunk.length + char.length > MAX_TEXT_PACKET &&
        !flush()
      )
        return "interrupted";
      chunk += char;
    }
  }
  return flush() ? "sent" : "interrupted";
}
