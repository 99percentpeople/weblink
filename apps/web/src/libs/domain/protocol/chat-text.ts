export const CHAT_MAX_TEXT_LENGTH = 64 * 1024;

export function normalizeChatText(text: string): string {
  const data = text.trim();
  if (!data || data.length > CHAT_MAX_TEXT_LENGTH)
    throw new Error(
      "Chat messages must contain 1 to 65536 characters",
    );
  return data;
}
