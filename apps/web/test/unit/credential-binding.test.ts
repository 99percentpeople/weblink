// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { webcrypto } from "node:crypto";
import { deviceIdentity } from "@/libs/domain/device-identity/crypto";
import {
  bindCredential,
  verifyBinding,
  type BoundCredential,
} from "@/libs/domain/device-identity/credential-binding";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
const identity = async () =>
  deviceIdentity(
    await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  );

it("binds a historical credential to both IDs and the direction, without revealing its secret", async () => {
  const issuer = await identity(),
    recipient = await identity();
  const credential = {
    id: crypto.randomUUID(),
    expiresAt: Date.now() - 1,
    secret: btoa("x".repeat(32)),
  };
  const binding = await bindCredential(credential, {
    identity: issuer,
    client: "issuer",
    target: "recipient",
    remoteKey: recipient.publicKey,
  });
  const proof: BoundCredential = {
    id: credential.id,
    expiresAt: credential.expiresAt,
    binding,
  };
  expect(
    await verifyBinding(
      proof,
      "issuer",
      "recipient",
      issuer.publicKey,
      recipient.publicKey,
    ),
  ).toBe(true);
  expect(
    await verifyBinding(
      proof,
      "different-id",
      "recipient",
      issuer.publicKey,
      recipient.publicKey,
    ),
  ).toBe(false);
  expect(
    await verifyBinding(
      proof,
      "issuer",
      "different-id",
      issuer.publicKey,
      recipient.publicKey,
    ),
  ).toBe(false);
  expect(
    await verifyBinding(
      proof,
      "recipient",
      "issuer",
      recipient.publicKey,
      issuer.publicKey,
    ),
  ).toBe(false);
  expect(JSON.stringify(proof)).not.toContain(
    credential.secret,
  );
});
