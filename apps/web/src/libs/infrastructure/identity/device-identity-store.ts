import {
  deviceIdentity,
  type DeviceIdentity,
} from "@/libs/domain/device-identity/crypto";
import type {
  CredentialStore,
  PairingCredentials,
} from "@/libs/domain/device-identity/credentials";
export interface DevicePin {
  fingerprint: string;
  blocked: boolean;
  /** Requires pairing-key proofs or explicitly negotiated identity recovery. */
  credentialRequired?: boolean;
}
/** A local profile owns its own private key and its own peer trust decisions. */
export interface DeviceIdentityStore {
  identity(): Promise<DeviceIdentity>;
  pin(peer: string): Promise<DevicePin | undefined>;
  save(peer: string, value: DevicePin): Promise<void>;
  /** Commits first-use/manual pairing and revokes previous pairing keys atomically. */
  pair(peer: string, value: DevicePin): Promise<void>;
  credentials?(peer: string): CredentialStore;
}
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>(
    (resolve, reject) => {
      const r = indexedDB.open(
        "weblink-device-identity",
        1,
      );
      r.onupgradeneeded = () =>
        r.result.createObjectStore("identity");
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          database = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        database = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        database = undefined;
        reject(new Error("IDENTITY_STORAGE_BLOCKED"));
      };
    },
  ));
}
async function read<T>(
  key: string,
): Promise<T | undefined> {
  const tx = (await db()).transaction(
    "identity",
    "readonly",
  );
  return request(tx.objectStore("identity").get(key));
}
async function update<T>(
  key: string,
  change: (existing: T | undefined) => T,
): Promise<T> {
  const tx = (await db()).transaction(
    "identity",
    "readwrite",
  );
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ?? new Error("IDENTITY_STORAGE_FAILED"),
      );
    tx.onerror = () => {};
  });
  const store = tx.objectStore("identity");
  void completed.catch(() => {});
  const existing = await request<T | undefined>(
    store.get(key),
  );
  let result: T;
  try {
    result = change(existing);
    store.put(result, key);
  } catch (error) {
    tx.abort();
    throw error;
  }
  await completed;
  return result;
}
async function updatePeer(
  peer: string,
  change: (
    pin: DevicePin | undefined,
    keys: PairingCredentials,
  ) => {
    pin: DevicePin | undefined;
    keys: PairingCredentials;
  },
): Promise<PairingCredentials> {
  const tx = (await db()).transaction(
    "identity",
    "readwrite",
  );
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(
        tx.error ?? new Error("IDENTITY_STORAGE_FAILED"),
      );
    tx.onerror = () => {};
  });
  void completed.catch(() => {});
  const table = tx.objectStore("identity");
  const [pin, keys] = await Promise.all([
    request<DevicePin | undefined>(
      table.get(`peer:${peer}`),
    ),
    request<PairingCredentials | undefined>(
      table.get(`credentials:${peer}`),
    ),
  ]);
  let next: ReturnType<typeof change>;
  try {
    next = change(pin, keys ?? {});
    if (next.pin) table.put(next.pin, `peer:${peer}`);
    table.put(next.keys, `credentials:${peer}`);
  } catch (error) {
    tx.abort();
    throw error;
  }
  await completed;
  return next.keys;
}
let identity: Promise<DeviceIdentity> | undefined;
export const deviceIdentityStore: DeviceIdentityStore = {
  identity() {
    return (identity ??= (async () => {
      let pair = await read<CryptoKeyPair>("local");
      if (!pair?.publicKey || !pair.privateKey) {
        const generated = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign", "verify"],
        );
        pair = await update<CryptoKeyPair>(
          "local",
          (existing) =>
            existing?.publicKey && existing.privateKey
              ? existing
              : generated,
        );
      }
      return deviceIdentity(pair);
    })().catch((error) => {
      identity = undefined;
      throw error;
    }));
  },
  pin: (peer) => read<DevicePin>(`peer:${peer}`),
  save: async (peer, value) => {
    await update<DevicePin>(`peer:${peer}`, () => value);
  },
  pair: async (peer, value) => {
    await updatePeer(peer, () => ({
      pin: value,
      keys: {},
    }));
  },
  credentials: (peer) => ({
    read: async () =>
      (await read<PairingCredentials>(
        `credentials:${peer}`,
      )) ?? {},
    update: (change) =>
      updatePeer(peer, (pin, keys) => {
        const next = change(keys);
        return {
          // A received key has a durable issuer outbox; an issued key has an ACK.
          // A pending offer alone may never have reached the other device.
          pin:
            pin && (next.received || next.issued)
              ? { ...pin, credentialRequired: true }
              : pin,
          keys: next,
        };
      }),
  }),
};
