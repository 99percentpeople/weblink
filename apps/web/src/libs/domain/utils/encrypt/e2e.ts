import {
  cryptography,
  type Cryptography,
} from "./cryptography";
import {
  concatBytes,
  equalBytes,
  fromBase64,
  randomBytes,
  toBase64,
} from "./bytes";

const ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const MAX_RECEIVE_KEYS = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function hashPassword(
  password: string,
  saltLength = SALT_LENGTH,
  iterations = ITERATIONS,
  hash = "SHA-256",
): Promise<string> {
  const salt = randomBytes(saltLength);
  return toBase64(
    concatBytes(
      salt,
      await cryptography.derive(
        password,
        salt,
        iterations,
        hash,
      ),
    ),
  );
}
export async function comparePasswordHash(
  password: string,
  storedHash: string,
  saltLength = SALT_LENGTH,
  iterations = ITERATIONS,
  hash = "SHA-256",
): Promise<boolean> {
  const combined = fromBase64(storedHash);
  if (combined.length !== saltLength + 32)
    throw new Error("Invalid password hash length");
  const derived = await cryptography.derive(
    password,
    combined.subarray(0, saltLength),
    iterations,
    hash,
  );
  return equalBytes(derived, combined.subarray(saltLength));
}
export interface PasswordCipher {
  encrypt(data: string): Promise<string>;
  decrypt(data: string): Promise<string>;
  dispose(): void;
}
/** Connection-owned keys, retaining the deployed salt/IV/ciphertext format. */
export function createPasswordCipher(
  password: string,
  provider: Cryptography = cryptography,
): PasswordCipher {
  let secret: string | undefined = password;
  let outgoing:
    | {
        salt: Uint8Array;
        key: Promise<Uint8Array>;
        count: number;
      }
    | undefined;
  const incoming = new Map<string, Promise<Uint8Array>>();
  const derive = (salt: Uint8Array) => {
    if (secret === undefined)
      throw new Error("Password cipher is closed");
    return provider.derive(
      secret,
      salt,
      ITERATIONS,
      "SHA-256",
    );
  };
  const checkOpen = () => {
    if (secret === undefined)
      throw new Error("Password cipher is closed");
  };
  const erase = (key: Promise<Uint8Array>) => {
    void key.then(
      (bytes) => bytes.fill(0),
      () => {},
    );
  };
  return {
    async encrypt(data) {
      checkOpen();
      // Fresh salt on rotation; every message has a fresh random 96-bit IV.
      if (!outgoing || outgoing.count >= 1_000_000) {
        const salt = randomBytes(SALT_LENGTH);
        outgoing = { salt, key: derive(salt), count: 0 };
      }
      const current = outgoing;
      current.count++;
      const iv = randomBytes(IV_LENGTH);
      const key = await current.key;
      checkOpen();
      const encrypted = await provider.encrypt(
        key,
        iv,
        encoder.encode(data),
      );
      checkOpen();
      return toBase64(
        concatBytes(current.salt, iv, encrypted),
      );
    },
    async decrypt(data) {
      checkOpen();
      const combined = fromBase64(data);
      if (combined.length < SALT_LENGTH + IV_LENGTH + 16)
        throw new Error("Invalid encrypted signal length");
      const salt = combined.subarray(0, SALT_LENGTH);
      const identity = toBase64(salt);
      let key = incoming.get(identity);
      if (!key) {
        key = derive(salt);
        incoming.set(identity, key);
        if (incoming.size > MAX_RECEIVE_KEYS)
          incoming.delete(incoming.keys().next().value!);
      }
      try {
        const derived = await key;
        checkOpen();
        const decrypted = await provider.decrypt(
          derived,
          combined.subarray(
            SALT_LENGTH,
            SALT_LENGTH + IV_LENGTH,
          ),
          combined.subarray(SALT_LENGTH + IV_LENGTH),
        );
        checkOpen();
        return decoder.decode(decrypted);
      } catch (error) {
        if (incoming.get(identity) === key)
          incoming.delete(identity);
        throw error;
      }
    },
    dispose() {
      secret = undefined;
      if (outgoing) erase(outgoing.key);
      outgoing = undefined;
      for (const key of incoming.values()) erase(key);
      incoming.clear();
    },
  };
}
