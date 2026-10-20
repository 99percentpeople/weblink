import {
  base64,
  bytes,
  verify,
  type DeviceIdentity,
} from "./crypto";

/** Public evidence attached to an existing pairing key, never another secret. */
export interface CredentialBinding {
  issuerKey: string;
  recipientKey: string;
  secretHash: string;
  signature: string;
}
export interface BoundCredential {
  id: string;
  expiresAt: number;
  binding?: CredentialBinding;
}
export interface BindingContext {
  identity: DeviceIdentity;
  client: string;
  target: string;
  remoteKey: string;
}
const transcript = (
  credential: BoundCredential,
  issuer: string,
  recipient: string,
) =>
  JSON.stringify([
    "weblink-pairing-key-binding/1",
    issuer,
    recipient,
    credential.id,
    credential.expiresAt,
    credential.binding?.issuerKey,
    credential.binding?.recipientKey,
    credential.binding?.secretHash,
  ]);
const secretHash = async (secret: string) =>
  base64(
    await crypto.subtle.digest("SHA-256", bytes(secret)),
  );

export async function bindCredential(
  credential: BoundCredential & { secret: string },
  context: BindingContext,
): Promise<CredentialBinding> {
  const binding: CredentialBinding = {
    issuerKey: context.identity.publicKey,
    recipientKey: context.remoteKey,
    secretHash: await secretHash(credential.secret),
    signature: "",
  };
  binding.signature = await context.identity.sign(
    transcript(
      { ...credential, binding },
      context.client,
      context.target,
    ),
  );
  return binding;
}

/** Expiry schedules renewal; it does not revoke a historical pairing. */
export async function verifyBinding(
  value: unknown,
  issuer: string,
  recipient: string,
  issuerKey: string,
  recipientKey: string,
): Promise<boolean> {
  if (!value || typeof value !== "object") return false;
  const credential = value as BoundCredential;
  const binding = credential.binding;
  if (
    typeof credential.id !== "string" ||
    !/^[a-f0-9-]{36}$/.test(credential.id) ||
    !Number.isSafeInteger(credential.expiresAt) ||
    credential.expiresAt <= 0 ||
    !binding ||
    binding.issuerKey !== issuerKey ||
    binding.recipientKey !== recipientKey ||
    typeof binding.secretHash !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(binding.secretHash) ||
    typeof binding.signature !== "string"
  )
    return false;
  return verify(
    issuerKey,
    transcript(credential, issuer, recipient),
    binding.signature,
  );
}

export async function verifyCredentialBinding(
  credential: BoundCredential & { secret: string },
  context: BindingContext,
  issued: boolean,
): Promise<boolean> {
  return (
    (await verifyBinding(
      credential,
      issued ? context.client : context.target,
      issued ? context.target : context.client,
      issued
        ? context.identity.publicKey
        : context.remoteKey,
      issued
        ? context.remoteKey
        : context.identity.publicKey,
    )) &&
    credential.binding?.secretHash ===
      (await secretHash(credential.secret))
  );
}
