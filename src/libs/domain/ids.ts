export type RoomID = string;
export type ClientID = string;
export type SessionID = string;
export type FileID = string;

export const CLIENT_ID_PREFIX = "uid_";

const CLIENT_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function createClientId(): ClientID {
  // Six random bits per character: 96 bits in a URL-safe suffix.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let id = CLIENT_ID_PREFIX;
  for (const byte of bytes) {
    id += CLIENT_ID_ALPHABET[byte & 63];
  }
  return id;
}
