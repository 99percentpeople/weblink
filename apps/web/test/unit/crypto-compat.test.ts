import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  createHash,
  createHmac,
  webcrypto,
} from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { useSoftwareCrypto } from "../helpers/crypto";
import {
  generateP256KeyPair,
  openP256KeyPair,
  sha256,
  hmacSha256,
  verifyHmacSha256,
  validateP256PublicKey,
  verifyP256,
} from "@/libs/domain/utils/crypto-compat";

const message = new TextEncoder().encode("设备配对 🔑");
const secret = new Uint8Array(32).fill(0xa5);
const raw = (value: ArrayBuffer) => new Uint8Array(value);
const hex = (value: ArrayBuffer) =>
  Buffer.from(value).toString("hex");
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["native", "software"])(
  "matches SHA-256 and HMAC vectors with %s crypto",
  async (backend) => {
    if (backend === "software") useSoftwareCrypto();
    expect(hex(await sha256(message))).toBe(
      createHash("sha256").update(message).digest("hex"),
    );
    const mac = raw(await hmacSha256(secret, message));
    expect(Buffer.from(mac).toString("hex")).toBe(
      createHmac("sha256", secret)
        .update(message)
        .digest("hex"),
    );
    expect(
      await verifyHmacSha256(secret, message, mac),
    ).toBe(true);
    expect(
      await verifyHmacSha256(secret, new Uint8Array(), mac),
    ).toBe(false);
    mac[0] ^= 1;
    expect(
      await verifyHmacSha256(secret, message, mac),
    ).toBe(false);
    expect(
      await verifyHmacSha256(
        secret,
        message,
        mac.subarray(1),
      ),
    ).toBe(false);
  },
);

it("keeps native keys non-extractable and verifies both high-S and low-S native signatures without subtle", async () => {
  const pair = await generateP256KeyPair();
  expect("format" in pair).toBe(false);
  expect(
    (pair as CryptoKeyPair).privateKey.extractable,
  ).toBe(false);
  const signer = await openP256KeyPair(pair);
  const signed = raw(await signer.sign(message));
  const signature = p256.Signature.fromBytes(signed);
  const order = p256.Point.Fn.ORDER;
  const low =
    signature.s > order / 2n
      ? order - signature.s
      : signature.s;
  const lowProof = new p256.Signature(
    signature.r,
    low,
  ).toBytes();
  const highProof = new p256.Signature(
    signature.r,
    order - low,
  ).toBytes();
  useSoftwareCrypto();
  expect(
    await verifyP256(
      raw(signer.publicKey),
      message,
      lowProof,
    ),
  ).toBe(true);
  expect(
    await verifyP256(
      raw(signer.publicKey),
      message,
      highProof,
    ),
  ).toBe(true);
  expect(
    await verifyP256(
      raw(signer.publicKey),
      new Uint8Array(),
      signed,
    ),
  ).toBe(false);
  await expect(
    validateP256PublicKey(raw(signer.publicKey)),
  ).resolves.toBeUndefined();
});

it("uses the same persisted software identity with and without native crypto", async () => {
  useSoftwareCrypto();
  const pair = await generateP256KeyPair();
  expect("format" in pair && pair.format).toBe(
    "p256-software",
  );
  const signer = await openP256KeyPair(
    structuredClone(pair),
  );
  const signed = raw(await signer.sign(message));
  expect(raw(signer.publicKey)).toHaveLength(65);
  expect(signed).toHaveLength(64);
  vi.stubGlobal("crypto", webcrypto);
  expect(
    await verifyP256(
      raw(signer.publicKey),
      message,
      signed,
    ),
  ).toBe(true);
  const nativeImport = vi.spyOn(
    webcrypto.subtle,
    "importKey",
  );
  const reopened = await openP256KeyPair(
    structuredClone(pair),
  );
  expect(reopened.publicKey).toEqual(signer.publicKey);
  const nativeSigned = raw(await reopened.sign(message));
  expect(nativeImport).toHaveBeenCalledWith(
    "jwk",
    expect.objectContaining({ crv: "P-256" }),
    expect.anything(),
    false,
    ["sign"],
  );
  useSoftwareCrypto();
  expect(
    await verifyP256(
      raw(signer.publicKey),
      message,
      nativeSigned,
    ),
  ).toBe(true);
});

it("falls back for absent methods and NotSupportedError, not data or runtime errors", async () => {
  vi.stubGlobal("crypto", {
    subtle: {},
    getRandomValues:
      webcrypto.getRandomValues.bind(webcrypto),
  });
  expect(hex(await sha256(message))).toBe(
    createHash("sha256").update(message).digest("hex"),
  );
  vi.stubGlobal("crypto", webcrypto);
  const digest = vi
    .spyOn(webcrypto.subtle, "digest")
    .mockRejectedValue(
      new DOMException("Unsupported", "NotSupportedError"),
    );
  expect(hex(await sha256(message))).toBe(
    createHash("sha256").update(message).digest("hex"),
  );
  digest.mockRejectedValue(
    new DOMException("Invalid", "DataError"),
  );
  await expect(sha256(message)).rejects.toMatchObject({
    name: "DataError",
  });
  const generate = vi
    .spyOn(webcrypto.subtle, "generateKey")
    .mockRejectedValue(
      new DOMException("Unsupported", "NotSupportedError"),
    );
  expect(await generateP256KeyPair()).toMatchObject({
    format: "p256-software",
  });
  generate.mockRejectedValue(
    new Error("Unexpected native failure"),
  );
  await expect(generateP256KeyPair()).rejects.toThrow(
    "Unexpected native failure",
  );
});

it("preserves native verification failures instead of retrying valid proofs with software", async () => {
  const signer = await openP256KeyPair(
    await generateP256KeyPair(),
  );
  const proof = raw(await signer.sign(message));
  const mac = raw(await hmacSha256(secret, message));
  const verification = vi
    .spyOn(webcrypto.subtle, "verify")
    .mockResolvedValue(false);
  expect(
    await verifyP256(raw(signer.publicKey), message, proof),
  ).toBe(false);
  expect(await verifyHmacSha256(secret, message, mac)).toBe(
    false,
  );
  verification.mockRejectedValue(
    new DOMException("Invalid", "DataError"),
  );
  await expect(
    verifyP256(raw(signer.publicKey), message, proof),
  ).rejects.toMatchObject({ name: "DataError" });
  await expect(
    verifyHmacSha256(secret, message, mac),
  ).rejects.toMatchObject({ name: "DataError" });
});

it.each(["native", "software"])(
  "rejects malformed public keys and signatures with %s crypto",
  async (backend) => {
    if (backend === "software") useSoftwareCrypto();
    const signer = await openP256KeyPair(
      await generateP256KeyPair(),
    );
    const badKey = new Uint8Array(65);
    badKey[0] = 4;
    await expect(
      validateP256PublicKey(badKey),
    ).rejects.toThrow();
    await expect(
      validateP256PublicKey(
        raw(signer.publicKey).subarray(1),
      ),
    ).rejects.toThrow();
    expect(
      await verifyP256(
        raw(signer.publicKey),
        message,
        new Uint8Array(64),
      ),
    ).toBe(false);
    expect(
      await verifyP256(
        raw(signer.publicKey),
        message,
        new Uint8Array(63),
      ),
    ).toBe(false);
  },
);

it("rejects corrupt software keys and never generates weak random keys", async () => {
  useSoftwareCrypto();
  const pair = await generateP256KeyPair();
  if (!("format" in pair))
    throw new Error("Expected software pair");
  await expect(
    openP256KeyPair({
      ...pair,
      privateKey: new Uint8Array(32),
    }),
  ).rejects.toThrow();
  const other = await generateP256KeyPair();
  await expect(
    openP256KeyPair({
      ...pair,
      publicKey: other.publicKey as Uint8Array,
    }),
  ).rejects.toThrow();
  vi.stubGlobal("crypto", {});
  await expect(generateP256KeyPair()).rejects.toThrow();
});
