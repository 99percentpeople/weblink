import { gcm } from "@noble/ciphers/aes.js";
import {
  createHMAC,
  createSHA1,
  createSHA256,
  createSHA384,
  createSHA512,
  pbkdf2,
} from "hash-wasm";
import type { CryptoOperation } from "./crypto-worker-client";
function hasher(hash: string) {
  switch (hash) {
    case "SHA-1":
      return createSHA1();
    case "SHA-256":
      return createSHA256();
    case "SHA-384":
      return createSHA384();
    case "SHA-512":
      return createSHA512();
    default:
      throw new Error(`Unsupported password hash: ${hash}`);
  }
}
/** Worker implementation, exposed for standard-vector and interoperability tests. */
export async function runCryptoOperation(
  operation: CryptoOperation,
): Promise<Uint8Array> {
  switch (operation.type) {
    case "derive":
      return pbkdf2({
        password: operation.password,
        salt: operation.salt,
        iterations: operation.iterations,
        hashLength: 32,
        hashFunction: hasher(operation.hash),
        outputType: "binary",
      });
    case "encrypt":
      return gcm(operation.key, operation.iv).encrypt(
        operation.data,
      );
    case "decrypt":
      return gcm(operation.key, operation.iv).decrypt(
        operation.data,
      );
    case "hmac": {
      const hash = await createHMAC(
        createSHA1(),
        operation.key,
      );
      return hash
        .update(operation.message)
        .digest("binary");
    }
  }
}
