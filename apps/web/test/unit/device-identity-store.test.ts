// @vitest-environment jsdom
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { verify } from "@/libs/domain/device-identity/crypto";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());
async function store() {
  return (
    await import("@/libs/infrastructure/identity/device-identity-store")
  ).deviceIdentityStore;
}
const credential = () => ({
  id: crypto.randomUUID(),
  secret: btoa(
    String.fromCharCode(
      ...crypto.getRandomValues(new Uint8Array(32)),
    ),
  ),
  expiresAt: Date.now() + 10000,
  binding: {
    issuerKey: "issuer",
    recipientKey: "recipient",
    secretHash: "secret-hash",
    signature: "signature",
  },
});
it("promotes mandatory key authentication atomically with receipt, never just a pending offer", async () => {
  const s = await store(),
    pending = credential();
  await s.pair("peer", {
    fingerprint: "confirmed",
    blocked: false,
  });
  await s.credentials!("peer").update(() => ({ pending }));
  expect(
    (await s.pin("peer"))?.credentialRequired,
  ).not.toBe(true);
  await s.credentials!("peer").update((keys) => ({
    ...keys,
    received: credential(),
  }));
  expect((await s.pin("peer"))?.credentialRequired).toBe(
    true,
  );
  await s.credentials!("peer").update(() => ({}));
  expect((await s.pin("peer"))?.credentialRequired).toBe(
    true,
  );
  await s.pair("peer", {
    fingerprint: "reconfirmed",
    blocked: false,
  });
  expect(
    (await s.pin("peer"))?.credentialRequired,
  ).not.toBe(true);
  expect(await s.credentials!("peer").read()).toEqual({});
});
it("rolls back both the pin and keys if explicit re-pairing cannot commit", async () => {
  const s = await store();
  await s.pair("peer", {
    fingerprint: "original",
    blocked: true,
  });
  await s.credentials!("peer").update(() => ({
    issued: credential(),
    blocked: true,
  }));
  const before = await s.credentials!("peer").read();
  await expect(
    s.pair("peer", {
      fingerprint: () => {},
      blocked: false,
    } as unknown as import("@/libs/infrastructure/identity/device-identity-store").DevicePin),
  ).rejects.toThrow();
  expect((await s.pin("peer"))?.fingerprint).toBe(
    "original",
  );
  expect(await s.credentials!("peer").read()).toEqual(
    before,
  );
});
it("atomically preserves both directions when concurrent tabs update the same peer", async () => {
  const s = await store(),
    a = s.credentials!("peer"),
    b = s.credentials!("peer");
  const issued = credential(),
    received = credential();
  await Promise.all([
    a.update((latest) => ({ ...latest, issued })),
    b.update((latest) => ({ ...latest, received })),
  ]);
  expect(await a.read()).toEqual({ issued, received });
  await expect(
    a.update(() => {
      throw new Error("cancel");
    }),
  ).rejects.toThrow("cancel");
  expect(await b.read()).toEqual({ issued, received });
});
it("keeps exchanged pairing keys independent of a lost device pin", async () => {
  const s = await store(),
    received = credential();
  await s.credentials!("peer").update(() => ({ received }));
  expect(await s.pin("peer")).toBeUndefined();
  vi.resetModules();
  const reloaded = await store();
  expect(
    await reloaded.credentials!("peer").read(),
  ).toEqual({ received });
});
it("regenerates an incomplete local keypair without deleting the peer-issued key", async () => {
  const s = await store(),
    received = credential();
  const original = await s.identity();
  await s.credentials!("peer").update(() => ({ received }));
  const db = await new Promise<IDBDatabase>((resolve) => {
    const open = indexedDB.open("weblink-device-identity");
    open.onsuccess = () => resolve(open.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("identity", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const table = tx.objectStore("identity"),
      read = table.get("local");
    read.onsuccess = () =>
      table.put(
        { privateKey: read.result.privateKey },
        "local",
      );
  });
  db.close();
  vi.resetModules();
  const reloaded = await store(),
    next = await reloaded.identity();
  expect(next.publicKey).not.toBe(original.publicKey);
  expect(
    await verify(
      next.publicKey,
      "fresh",
      await next.sign("fresh"),
    ),
  ).toBe(true);
  expect(
    await reloaded.credentials!("peer").read(),
  ).toEqual({ received });
});
