import { p256 } from "@noble/curves/nist.js";
import { equalBytes } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import type { SoftwareP256KeyPair } from "./crypto-compat";

export { sha256 };
export const hmacSha256 = (
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array => hmac(sha256, key, data);
export const verifyHmacSha256 = (
  key: Uint8Array,
  data: Uint8Array,
  proof: Uint8Array,
): boolean => equalBytes(hmacSha256(key, data), proof);

export function generateP256KeyPair(): SoftwareP256KeyPair {
  // Noble uses crypto.getRandomValues, which is also available on HTTP origins.
  const privateKey = p256.utils.randomSecretKey();
  return {
    format: "p256-software",
    privateKey,
    publicKey: p256.getPublicKey(privateKey, false),
  };
}
export function validateP256PublicKey(
  key: Uint8Array,
): void {
  if (!p256.utils.isValidPublicKey(key, false))
    throw new Error("Invalid P-256 public key");
}
export function validateP256KeyPair(
  pair: SoftwareP256KeyPair,
): void {
  if (
    !p256.utils.isValidSecretKey(pair.privateKey) ||
    !equalBytes(
      p256.getPublicKey(pair.privateKey, false),
      pair.publicKey,
    )
  )
    throw new Error("Invalid P-256 key pair");
}
export const signP256 = (
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array =>
  p256.sign(data, key, {
    prehash: true,
    lowS: false,
    format: "compact",
  });
export const verifyP256 = (
  key: Uint8Array,
  data: Uint8Array,
  proof: Uint8Array,
): boolean =>
  // Web Crypto accepts both high-S and low-S signatures, encoded as 64-byte r||s.
  p256.verify(proof, data, key, {
    prehash: true,
    lowS: false,
    format: "compact",
  });
