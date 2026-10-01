export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536)
    crypto.getRandomValues(
      bytes.subarray(offset, offset + 65536),
    );
  return bytes;
}
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (
    let offset = 0;
    offset < bytes.length;
    offset += 8192
  )
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + 8192),
    );
  return btoa(binary);
}
export function fromBase64(value: string): Uint8Array {
  if (
    !value.length ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error("Invalid Base64 string");
  return Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
}
export function concatBytes(
  ...parts: Uint8Array[]
): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++)
    difference |= left[i] ^ right[i];
  return difference === 0;
}
