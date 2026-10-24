/** Native Web Crypto first; unsupported operations use the same wire formats. */
export interface SoftwareP256KeyPair {
  format: "p256-software";
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}
export type P256KeyPair =
  | CryptoKeyPair
  | SoftwareP256KeyPair;

const software = () => import("./crypto-compat-software");
const curve: EcKeyGenParams = {
  name: "ECDSA",
  namedCurve: "P-256",
};
const signature = { name: "ECDSA", hash: "SHA-256" };
const mac = { name: "HMAC", hash: "SHA-256" };
const buffer = (value: Uint8Array): ArrayBuffer =>
  Uint8Array.from(value).buffer;

async function compatible<T>(
  methods: (keyof SubtleCrypto)[],
  native: (subtle: SubtleCrypto) => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  const subtle = globalThis.crypto?.subtle;
  if (
    subtle &&
    methods.every((m) => typeof subtle[m] === "function")
  ) {
    try {
      return await native(subtle);
    } catch (error) {
      // Invalid data, denied access and verification failures must not downgrade.
      if (
        !(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "NotSupportedError"
        )
      )
        throw error;
    }
  }
  return fallback();
}

export function sha256(
  data: Uint8Array,
): Promise<ArrayBuffer> {
  return compatible(
    ["digest"],
    (s) => s.digest("SHA-256", buffer(data)),
    async () => buffer((await software()).sha256(data)),
  );
}
export function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<ArrayBuffer> {
  return compatible(
    ["importKey", "sign"],
    async (s) =>
      s.sign(
        "HMAC",
        await s.importKey("raw", buffer(key), mac, false, [
          "sign",
        ]),
        buffer(data),
      ),
    async () =>
      buffer((await software()).hmacSha256(key, data)),
  );
}
export function verifyHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
  proof: Uint8Array,
): Promise<boolean> {
  if (proof.length !== 32) return Promise.resolve(false);
  return compatible(
    ["importKey", "verify"],
    async (s) =>
      s.verify(
        "HMAC",
        await s.importKey("raw", buffer(key), mac, false, [
          "verify",
        ]),
        buffer(proof),
        buffer(data),
      ),
    async () =>
      (await software()).verifyHmacSha256(key, data, proof),
  );
}
function checkPublicKey(key: Uint8Array) {
  if (key.length !== 65 || key[0] !== 4)
    throw new Error(
      "Invalid uncompressed P-256 public key",
    );
}
export async function validateP256PublicKey(
  key: Uint8Array,
): Promise<void> {
  checkPublicKey(key);
  await compatible(
    ["importKey"],
    async (s) => {
      await s.importKey("raw", buffer(key), curve, false, [
        "verify",
      ]);
    },
    async () =>
      (await software()).validateP256PublicKey(key),
  );
}
export async function verifyP256(
  key: Uint8Array,
  data: Uint8Array,
  proof: Uint8Array,
): Promise<boolean> {
  checkPublicKey(key);
  if (proof.length !== 64) return false;
  return compatible(
    ["importKey", "verify"],
    async (s) =>
      s.verify(
        signature,
        await s.importKey(
          "raw",
          buffer(key),
          curve,
          false,
          ["verify"],
        ),
        buffer(proof),
        buffer(data),
      ),
    async () =>
      (await software()).verifyP256(key, data, proof),
  );
}
export function generateP256KeyPair(): Promise<P256KeyPair> {
  return compatible<P256KeyPair>(
    ["generateKey", "exportKey", "sign"],
    async (s) => {
      const pair = await s.generateKey(curve, false, [
        "sign",
        "verify",
      ]);
      // Check the operations needed by a local identity before persisting an
      // opaque private key that cannot later be converted to software.
      await s.exportKey("raw", pair.publicKey);
      await s.sign(
        signature,
        pair.privateKey,
        new Uint8Array(),
      );
      return pair;
    },
    async () => (await software()).generateP256KeyPair(),
  );
}

interface P256Signer {
  publicKey: ArrayBuffer;
  sign(data: Uint8Array): Promise<ArrayBuffer>;
}
const base64url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export async function openP256KeyPair(
  pair: P256KeyPair,
): Promise<P256Signer> {
  if ("format" in pair && pair.format === "p256-software") {
    const implementation = await software();
    implementation.validateP256KeyPair(pair);
    // Copy persisted bytes; callers cannot mutate a live signing identity.
    const privateKey = Uint8Array.from(pair.privateKey);
    const publicKey = Uint8Array.from(pair.publicKey);
    return {
      publicKey: publicKey.buffer,
      sign: (data) =>
        compatible(
          ["importKey", "sign"],
          async (s) => {
            const key = await s.importKey(
              "jwk",
              {
                kty: "EC",
                crv: "P-256",
                d: base64url(privateKey),
                x: base64url(publicKey.subarray(1, 33)),
                y: base64url(publicKey.subarray(33)),
              },
              curve,
              false,
              ["sign"],
            );
            return s.sign(signature, key, buffer(data));
          },
          async () =>
            buffer(
              implementation.signP256(privateKey, data),
            ),
        ),
    };
  }
  // Existing non-extractable CryptoKeys cannot be converted to software keys.
  // Preserve them and fail explicitly rather than silently replacing identity.
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.exportKey || !subtle.sign)
    throw new Error("IDENTITY_NATIVE_CRYPTO_UNAVAILABLE");
  const native = pair as CryptoKeyPair;
  return {
    publicKey: await subtle.exportKey(
      "raw",
      native.publicKey,
    ),
    sign: (data) =>
      subtle.sign(
        signature,
        native.privateKey,
        buffer(data),
      ),
  };
}
