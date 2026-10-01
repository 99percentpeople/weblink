import { randomBytes } from "./bytes";

function randomIndex(length: number): number {
  const limit = 256 - (256 % length);
  let byte: number;
  do {
    byte = randomBytes(1)[0];
  } while (byte >= limit);
  return byte % length;
}
export function generateStrongPassword(
  length = 12,
): string {
  const types = [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "!@#$%^&*()_+[]{}|;:,.<>?",
  ];
  if (
    !Number.isInteger(length) ||
    length < types.length ||
    length > 256
  )
    throw new Error(
      "Password length must be between 4 and 256",
    );
  const alphabet = types.join("");
  const characters = types.map(
    (type) => type[randomIndex(type.length)],
  );
  while (characters.length < length)
    characters.push(alphabet[randomIndex(alphabet.length)]);
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [characters[i], characters[j]] = [
      characters[j],
      characters[i],
    ];
  }
  return characters.join("");
}
