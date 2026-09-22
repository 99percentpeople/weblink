import {
  CryptoJSPromise,
  isCryptoSubtleAvailable,
} from ".";

// strong password generation function
export async function generateStrongPassword(
  length: number = 12,
): Promise<string> {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const specialChars = "!@#$%^&*()_+[]{}|;:,.<>?";
  const allChars =
    uppercase + lowercase + digits + specialChars;

  const types = [
    uppercase,
    lowercase,
    digits,
    specialChars,
  ];
  const passwordChars = [];

  if (length < types.length) {
    throw new Error("password length is too short.");
  }

  // ensure each type of character has at least one character
  for (const type of types) {
    const char = type.charAt(
      Math.floor(Math.random() * type.length),
    );
    passwordChars.push(char);
  }

  const remainingLength = length - types.length;

  if (isCryptoSubtleAvailable) {
    // using crypto.getRandomValues to generate random numbers
    const randomValues = new Uint32Array(remainingLength);
    window.crypto.getRandomValues(randomValues);
    for (let i = 0; i < remainingLength; i++) {
      const index = randomValues[i] % allChars.length;
      passwordChars.push(allChars.charAt(index));
    }
  } else {
    // using crypto-js to generate random numbers
    const CryptoJS = await CryptoJSPromise;
    if (!CryptoJS) {
      throw new Error("CryptoJS is not available");
    }
    const randomWords =
      CryptoJS.lib.WordArray.random(remainingLength).words;
    for (let i = 0; i < remainingLength; i++) {
      const wordIndex = i % randomWords.length;
      const word = randomWords[wordIndex];
      const byte = (word >> (8 * (i % 4))) & 0xff;
      const index = byte % allChars.length;
      passwordChars.push(allChars.charAt(index));
    }
  }

  // shuffle the characters
  for (let i = passwordChars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [passwordChars[i], passwordChars[j]] = [
      passwordChars[j],
      passwordChars[i],
    ];
  }

  return passwordChars.join("");
}
