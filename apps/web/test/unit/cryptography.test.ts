import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCryptography } from "@/libs/domain/utils/encrypt/cryptography";
import { runCryptoOperation } from "@/libs/domain/utils/encrypt/crypto-software";
import {
  createPasswordCipher,
  hashPassword,
  comparePasswordHash,
} from "@/libs/domain/utils/encrypt/e2e";
import {
  fromBase64,
  toBase64,
} from "@/libs/domain/utils/encrypt/bytes";
import { generateRoomPassword } from "@/libs/domain/utils/encrypt/room-password";

const native = createCryptography(
  webcrypto.subtle as SubtleCrypto,
);
const software = createCryptography(
  null,
  runCryptoOperation,
);
const bytes = (value: string) =>
  new TextEncoder().encode(value);
const hex = (value: Uint8Array) =>
  Buffer.from(value).toString("hex");

describe("native and HTTP cryptography", () => {
  it.each([native, software])(
    "matches PBKDF2 and HMAC standard vectors",
    async (provider) => {
      expect(
        hex(
          await provider.derive(
            "password",
            bytes("salt"),
            1,
            "SHA-256",
          ),
        ),
      ).toBe(
        "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
      );
      expect(
        hex(
          await provider.hmac(
            "key",
            "The quick brown fox jumps over the lazy dog",
          ),
        ),
      ).toBe("de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
    },
  );
  it.each([native, software])(
    "matches the AES-256-GCM empty plaintext vector",
    async (provider) => {
      expect(
        hex(
          await provider.encrypt(
            new Uint8Array(32),
            new Uint8Array(12),
            new Uint8Array(),
          ),
        ),
      ).toBe("530f8afbc74536b9a963b4f1c4cb738b");
    },
  );
  it.each([
    [native, software],
    [software, native],
  ])(
    "decrypts peer payloads across native and HTTP implementations",
    async (senderProvider, receiverProvider) => {
      const sender = createPasswordCipher(
        "密码 🔐",
        senderProvider,
      );
      const receiver = createPasswordCipher(
        "密码 🔐",
        receiverProvider,
      );
      try {
        const plain = "含中文、emoji 😀 的 SDP".repeat(
          10000,
        );
        expect(
          await receiver.decrypt(
            await sender.encrypt(plain),
          ),
        ).toBe(plain);
        expect(
          await receiver.decrypt(await sender.encrypt("")),
        ).toBe("");
      } finally {
        sender.dispose();
        receiver.dispose();
      }
    },
  );
  it("uses one derivation for concurrent signaling messages and a new IV for each", async () => {
    const senderProvider = {
      ...software,
      derive: vi.fn(software.derive),
    };
    const receiverProvider = {
      ...native,
      derive: vi.fn(native.derive),
    };
    const sender = createPasswordCipher(
        "password",
        senderProvider,
      ),
      receiver = createPasswordCipher(
        "password",
        receiverProvider,
      );
    try {
      const encrypted = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          sender.encrypt(String(i)),
        ),
      );
      expect(senderProvider.derive).toHaveBeenCalledTimes(
        1,
      );
      expect(
        new Set(
          encrypted.map((value) =>
            toBase64(fromBase64(value).subarray(16, 28)),
          ),
        ).size,
      ).toBe(8);
      expect(
        await Promise.all(
          encrypted.map((value) => receiver.decrypt(value)),
        ),
      ).toEqual(
        Array.from({ length: 8 }, (_, i) => String(i)),
      );
      expect(receiverProvider.derive).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });
  it("rejects tampered tags, wrong passwords and truncated payloads", async () => {
    const sender = createPasswordCipher("correct", native),
      receiver = createPasswordCipher("wrong", software);
    try {
      const encrypted = await sender.encrypt("sdp");
      await expect(
        receiver.decrypt(encrypted),
      ).rejects.toThrow();
      const payload = fromBase64(encrypted);
      payload[payload.length - 1] ^= 1;
      await expect(
        sender.decrypt(toBase64(payload)),
      ).rejects.toThrow();
      await expect(
        sender.decrypt(toBase64(new Uint8Array(43))),
      ).rejects.toThrow("length");
      await expect(sender.decrypt("bad%")).rejects.toThrow(
        "Base64",
      );
    } finally {
      sender.dispose();
      receiver.dispose();
    }
  });
  it("retains the password verifier format and rejects malformed verifiers", async () => {
    const verifier = await hashPassword(
      "房间密码",
      16,
      1000,
    );
    expect(fromBase64(verifier)).toHaveLength(48);
    expect(
      await comparePasswordHash(
        "房间密码",
        verifier,
        16,
        1000,
      ),
    ).toBe(true);
    expect(
      await comparePasswordHash(
        "wrong",
        verifier,
        16,
        1000,
      ),
    ).toBe(false);
    await expect(
      comparePasswordHash(
        "password",
        toBase64(new Uint8Array(47)),
      ),
    ).rejects.toThrow("length");
  });
  it("does not complete a cipher operation after disposal", async () => {
    let finish!: (value: Uint8Array) => void;
    const provider = {
      ...software,
      derive: () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        }),
    };
    const cipher = createPasswordCipher(
      "password",
      provider,
    );
    const pending = cipher.encrypt("message");
    const rejected =
      expect(pending).rejects.toThrow("closed");
    cipher.dispose();
    finish(new Uint8Array(32));
    await rejected;
    await expect(cipher.encrypt("later")).rejects.toThrow(
      "closed",
    );
  });
  it("generates six-digit room passwords without subtle or randomUUID", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues:
        original.getRandomValues.bind(original),
    });
    try {
      expect(generateRoomPassword()).toMatch(/^[0-9]{6}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("preserves leading zeroes and rejects biased digit samples", () => {
    const samples = [0, 250, 255, 1, 249, 2, 3, 4];
    let index = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) {
          if (index >= samples.length)
            throw new Error("Unexpected random read");
          array[i] = samples[index++];
        }
        return array;
      },
    });
    try {
      expect(generateRoomPassword()).toBe("019234");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
