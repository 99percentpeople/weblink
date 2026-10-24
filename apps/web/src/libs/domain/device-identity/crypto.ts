import {
  openP256KeyPair,
  sha256,
  verifyP256,
  type P256KeyPair,
} from "../utils/crypto-compat";

/** Device keys sign fresh connection transcripts; they are never encryption keys. */
export interface DeviceIdentity {
  publicKey: string;
  sign(message: string): Promise<string>;
}
export const bytes = (
  text: string,
): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const base64 = (data: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(data)));
const encoded = (text: string) =>
  new TextEncoder().encode(text);
export async function fingerprint(
  key: string,
): Promise<string> {
  return [...new Uint8Array(await sha256(bytes(key)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export async function verify(
  key: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    if (key.length !== 88 || signature.length !== 88)
      return false;
    return await verifyP256(
      bytes(key),
      encoded(message),
      bytes(signature),
    );
  } catch {
    return false;
  }
}
export async function deviceIdentity(
  pair: P256KeyPair,
): Promise<DeviceIdentity> {
  const signer = await openP256KeyPair(pair);
  return {
    publicKey: base64(signer.publicKey),
    sign: async (message) =>
      base64(await signer.sign(encoded(message))),
  };
}
export const joinTranscript = (
  challenge: string,
  clientId: string,
  createdAt: number,
) =>
  JSON.stringify([
    "weblink-signaling-identity/1",
    challenge,
    clientId,
    createdAt,
  ]);
export const IDENTITY_CHANNEL = "weblink-device-identity/1";
export function transportFingerprint(
  sdp: string | undefined,
): string {
  const fingerprints = [
    ...new Set(
      (sdp ?? "")
        .split(/\r?\n/)
        .filter((v) =>
          v.startsWith("a=fingerprint:sha-256 "),
        )
        .map((v) =>
          v
            .slice("a=fingerprint:sha-256 ".length)
            .toLowerCase(),
        ),
    ),
  ].sort();
  if (
    !fingerprints.length ||
    fingerprints.some(
      (v) => !/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/.test(v),
    )
  )
    throw new Error("IDENTITY_TRANSPORT_UNAVAILABLE");
  return fingerprints.join(",");
}
