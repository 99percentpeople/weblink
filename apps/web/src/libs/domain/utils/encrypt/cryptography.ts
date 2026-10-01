import {
  CryptoWorkerClient,
  type CryptoOperation,
} from "./crypto-worker-client";
import { toBase64 } from "./bytes";

export interface Cryptography {
  derive(
    password: string,
    salt: Uint8Array,
    iterations: number,
    hash: string,
  ): Promise<Uint8Array>;
  encrypt(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ): Promise<Uint8Array>;
  decrypt(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ): Promise<Uint8Array>;
  hmac(key: string, message: string): Promise<Uint8Array>;
}
const encoder = new TextEncoder();
const worker = new CryptoWorkerClient();
/** Capability selection belongs here; business code calls the same operations everywhere. */
export function createCryptography(
  subtle: SubtleCrypto | null | undefined = globalThis
    .crypto?.subtle,
  fallback: (
    operation: CryptoOperation,
  ) => Promise<Uint8Array> = (operation) =>
    worker.run(operation),
): Cryptography {
  if (!subtle)
    return {
      derive: (password, salt, iterations, hash) =>
        fallback({
          type: "derive",
          password,
          salt,
          iterations,
          hash,
        }),
      encrypt: (key, iv, data) =>
        fallback({ type: "encrypt", key, iv, data }),
      decrypt: (key, iv, data) =>
        fallback({ type: "decrypt", key, iv, data }),
      hmac: (key, message) =>
        fallback({ type: "hmac", key, message }),
    };
  const aesKeys = new WeakMap<
    Uint8Array,
    Promise<CryptoKey>
  >();
  const aesKey = (key: Uint8Array) => {
    let imported = aesKeys.get(key);
    if (!imported) {
      imported = subtle.importKey(
        "raw",
        Uint8Array.from(key),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      aesKeys.set(key, imported);
    }
    return imported;
  };
  return {
    async derive(password, salt, iterations, hash) {
      const key = await subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveBits"],
      );
      return new Uint8Array(
        await subtle.deriveBits(
          {
            name: "PBKDF2",
            salt: Uint8Array.from(salt),
            iterations,
            hash,
          },
          key,
          256,
        ),
      );
    },
    async encrypt(key, iv, data) {
      return new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv: Uint8Array.from(iv) },
          await aesKey(key),
          Uint8Array.from(data),
        ),
      );
    },
    async decrypt(key, iv, data) {
      return new Uint8Array(
        await subtle.decrypt(
          { name: "AES-GCM", iv: Uint8Array.from(iv) },
          await aesKey(key),
          Uint8Array.from(data),
        ),
      );
    },
    async hmac(key, message) {
      const imported = await subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"],
      );
      return new Uint8Array(
        await subtle.sign(
          "HMAC",
          imported,
          encoder.encode(message),
        ),
      );
    },
  };
}
export const cryptography = createCryptography();

export async function generateHMAC(
  key: string,
  message: string,
): Promise<string> {
  return toBase64(await cryptography.hmac(key, message));
}
