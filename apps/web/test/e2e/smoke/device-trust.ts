const traces: unknown[] = [];
for (const key of ["warn", "error", "debug"] as const) {
  const original = console[key].bind(console);
  console[key] = (...args) => {
    traces.push(
      args.map((v) => (v instanceof Error ? v.message : v)),
    );
    original(...args);
  };
}
import {
  createEffect,
  createRoot,
  createSignal,
} from "solid-js";
import { PeerSession } from "../../../src/libs/domain/session";
import { PeerTrustService } from "../../../src/libs/application/peer-trust";
import {
  deviceIdentity,
  verify,
  type DeviceIdentity,
} from "../../../src/libs/domain/device-identity/crypto";
import { bootstrapMessage } from "../../../src/libs/domain/device-identity/access";
import type {
  CredentialStore,
  PairingCredentials,
} from "../../../src/libs/domain/device-identity/credentials";
import {
  deviceIdentityStore,
  type DevicePin,
} from "../../../src/libs/infrastructure/identity/device-identity-store";
import { MultiEventEmitter } from "../../../src/libs/utils/event-emitter";
import { createSessionMessage } from "../../../src/libs/domain/protocol/messages";
import type {
  RawSignal,
  SignalingService,
  SignalingServiceEventMap,
} from "../../../src/libs/domain/signaling";
const assert = (value: unknown, label: string) => {
  if (!value) throw new Error(label);
};
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error(`Timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
class Sender implements SignalingService {
  readonly events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  status = "connected" as const;
  remote!: Sender;
  constructor(
    readonly clientId: string,
    readonly targetClientId: string,
  ) {}
  addEventListener = this.events.addEventListener.bind(
    this.events,
  );
  removeEventListener =
    this.events.removeEventListener.bind(this.events);
  async sendSignal(signal: RawSignal) {
    queueMicrotask(() =>
      this.remote.events.dispatchEvent("signal", {
        ...signal,
        clientId: this.clientId,
        targetClientId: this.targetClientId,
        data: JSON.parse(signal.data),
      }),
    );
  }
  close() {
    this.events.clearListeners();
  }
}
const newIdentity = async () =>
  deviceIdentity(
    await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  );
async function connection(
  a: DeviceIdentity,
  b: DeviceIdentity,
  pinsA: Map<string, DevicePin>,
  pinsB: Map<string, DevicePin>,
  keysA: Map<string, PairingCredentials>,
  keysB: Map<string, PairingCredentials>,
  initialReceive = false,
  interruptKeyDelivery = false,
) {
  const left = new Sender("a", "b"),
    right = new Sender("b", "a");
  left.remote = right;
  right.remote = left;
  const receiveA = createSignal(initialReceive),
    receiveB = createSignal(initialReceive);
  const credentials = (
    keys: Map<string, PairingCredentials>,
    pins: Map<string, DevicePin>,
    id: string,
  ): CredentialStore => ({
    read: async () => structuredClone(keys.get(id) ?? {}),
    update: async (change) => {
      const value = structuredClone(
        change(structuredClone(keys.get(id) ?? {})),
      );
      keys.set(id, value);
      const pin = pins.get(id);
      if (pin && (value.issued || value.received))
        pins.set(id, { ...pin, credentialRequired: true });
      return value;
    },
  });
  const trustA = new PeerTrustService(
    {
      quarantine: () => receiveA[1](false),
      paired: () => receiveA[1](true),
    },
    {
      identity: async () => a,
      pin: async (id) => pinsA.get(id),
      save: async (id, pin) => {
        pinsA.set(id, pin);
      },
      pair: async (id, pin) => {
        pinsA.set(id, pin);
        keysA.set(id, {});
      },
      credentials: (id) => credentials(keysA, pinsA, id),
    },
  );
  const trustB = new PeerTrustService(
    {
      quarantine: () => receiveB[1](false),
      paired: () => receiveB[1](true),
    },
    {
      identity: async () => b,
      pin: async (id) => pinsB.get(id),
      save: async (id, pin) => {
        pinsB.set(id, pin);
      },
      pair: async (id, pin) => {
        pinsB.set(id, pin);
        keysB.set(id, {});
      },
      credentials: (id) => credentials(keysB, pinsB, id),
    },
  );
  const allowedA = () =>
      trustA.trusted("b") && receiveA[0](),
    allowedB = () => trustB.trusted("a") && receiveB[0]();
  const sessionA = new PeerSession(left, {
    polite: false,
    allowsApplication: () => trustA.trusted("b"),
    acceptsContent: allowedA,
    acceptMessage: (m) =>
      bootstrapMessage(m.type) || allowedA(),
  });
  const sessionB = new PeerSession(right, {
    polite: true,
    allowsApplication: () => trustB.trusted("a"),
    acceptsContent: allowedB,
    acceptMessage: (m) =>
      bootstrapMessage(m.type) || allowedB(),
  });
  if (interruptKeyDelivery)
    sessionB.addEventListener(
      "channel",
      ({ detail: channel }) => {
        if (channel.label !== "weblink-device-identity/1")
          return;
        const send = channel.send.bind(channel);
        channel.send = ((data: string) => {
          if (
            !JSON.parse(data).kind.startsWith("credential-")
          )
            send(data);
        }) as typeof channel.send;
      },
    );
  const offA = trustA.bind(sessionA),
    offB = trustB.bind(sessionB);
  const dispose = createRoot((dispose) => {
    createEffect(() => sessionA.refreshAccess());
    createEffect(() => sessionB.refreshAccess());
    return dispose;
  });
  const received: string[] = [];
  let remote: MediaStream | null = null;
  sessionA.addEventListener("message", ({ detail }) => {
    if (detail.type === "send-text")
      received.push(detail.data);
  });
  sessionA.addEventListener(
    "remotestreamchange",
    ({ detail }) => {
      remote = detail;
    },
  );
  await Promise.all([sessionA.listen(), sessionB.listen()]);
  await sessionA.connect();
  try {
    await until(
      () =>
        !!trustA.get("b")?.code && !!trustB.get("a")?.code,
      "device proofs",
    );
  } catch (error) {
    throw new Error(
      `${String(error)} ${JSON.stringify({ a: trustA.get("b"), b: trustB.get("a"), pcA: sessionA.peerConnection?.connectionState, pcB: sessionB.peerConnection?.connectionState, messageA: sessionA.isMessageChannelReady, messageB: sessionB.isMessageChannelReady, traces })}`,
    );
  }
  return {
    sessionA,
    sessionB,
    trustA,
    trustB,
    receiveA,
    receiveB,
    received,
    remote: () => remote,
    close: () => {
      dispose();
      offA();
      offB();
      sessionA.close();
      sessionB.close();
    },
  };
}
async function checkInterruptedExchange(
  a: DeviceIdentity,
  b: DeviceIdentity,
) {
  const pinsA = new Map<string, DevicePin>(),
    pinsB = new Map<string, DevicePin>();
  const keysA = new Map<string, PairingCredentials>(),
    keysB = new Map<string, PairingCredentials>();
  const first = await connection(
    a,
    b,
    pinsA,
    pinsB,
    keysA,
    keysB,
    false,
    true,
  );
  try {
    await until(
      () => !!keysB.get("a")?.pending,
      "first issuance persisted before interruption",
    );
    assert(
      keysB.get("a")?.pending && !keysA.get("b")?.received,
      "first issuance remains undelivered",
    );
  } finally {
    first.close();
  }
  const resumed = await connection(
    a,
    b,
    pinsA,
    pinsB,
    keysA,
    keysB,
    true,
  );
  try {
    assert(
      resumed.trustA.trusted("b") &&
        resumed.trustB.trusted("a"),
      "incomplete first exchange resumes",
    );
    assert(
      resumed.receiveA[0]() && resumed.receiveB[0](),
      "interrupted first exchange preserves permissions",
    );
    await until(
      () =>
        !!keysA.get("b")?.issued &&
        !!keysB.get("a")?.issued &&
        keysA.get("b")?.received?.id ===
          keysB.get("a")?.issued?.id &&
        keysB.get("a")?.received?.id ===
          keysA.get("b")?.issued?.id,
      "resumed first key exchange",
    );
  } finally {
    resumed.close();
  }
}
async function main() {
  const local = await deviceIdentityStore.identity();
  assert(
    await verify(
      local.publicKey,
      "persistence",
      await local.sign("persistence"),
    ),
    "persistent identity signing",
  );
  const db = await new Promise<IDBDatabase>(
    (resolve, reject) => {
      const r = indexedDB.open("weblink-device-identity");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    },
  );
  const pair = await new Promise<CryptoKeyPair>(
    (resolve, reject) => {
      const r = db
        .transaction("identity")
        .objectStore("identity")
        .get("local");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    },
  );
  db.close();
  assert(
    pair.privateKey.extractable === false,
    "private key is non-extractable",
  );
  const reloaded = await deviceIdentity(pair);
  assert(
    reloaded.publicKey === local.publicKey &&
      (await verify(
        local.publicKey,
        "reload",
        await reloaded.sign("reload"),
      )),
    "IDB key round trip",
  );
  const a = await newIdentity(),
    b = await newIdentity(),
    pinsA = new Map<string, DevicePin>(),
    pinsB = new Map<string, DevicePin>(),
    keysA = new Map<string, PairingCredentials>(),
    keysB = new Map<string, PairingCredentials>();
  const keysSettled = () =>
    !!keysA.get("b")?.issued &&
    !!keysB.get("a")?.issued &&
    keysA.get("b")?.issued?.id ===
      keysB.get("a")?.received?.id &&
    keysB.get("a")?.issued?.id ===
      keysA.get("b")?.received?.id &&
    !keysA.get("b")?.pending &&
    !keysB.get("a")?.pending;
  await checkInterruptedExchange(a, b);
  const first = await connection(
    a,
    b,
    pinsA,
    pinsB,
    keysA,
    keysB,
  );
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext("2d")!;
  const draw = setInterval(() => {
    context.fillStyle = "green";
    context.fillRect(0, 0, 160, 90);
  }, 50);
  const stream = canvas.captureStream(10);
  try {
    assert(
      first.trustA.trusted("b") &&
        first.trustB.trusted("a"),
      "new devices pair automatically after proof verification",
    );
    const proofA = first.trustA.get("b")!,
      proofB = first.trustB.get("a")!;
    assert(
      proofA.code === proofB.code,
      "pairing code agrees over actual DTLS",
    );
    await until(
      keysSettled,
      "initial pairing key exchange",
    );
    const persistentKeys = deviceIdentityStore.credentials!(
      "browser-key-roundtrip",
    );
    const saved = await persistentKeys.update(
      () => keysA.get("b")!,
    );
    const restored = await persistentKeys.read();
    assert(
      saved.issued?.secret === restored.issued?.secret &&
        saved.received?.secret ===
          restored.received?.secret,
      "pairing key IDB round trip",
    );
    assert(
      first.receiveA[0]() && first.receiveB[0](),
      "first pairing enables reception by default",
    );
    await first.sessionB.sendMessage(
      createSessionMessage(first.sessionB, "send-text", {
        data: "allowed",
      }),
    );
    await until(
      () => first.received.includes("allowed"),
      "allowed message",
    );
    const file = await first.sessionB.createChannel(
      "test-file",
      "test-file",
    );
    first.sessionB.setStream(stream);
    await until(
      () => !!first.remote()?.getVideoTracks().length,
      "received media",
    );
    const track = first.remote()!.getVideoTracks()[0];
    first.receiveA[1](false);
    await until(
      () => file.readyState === "closed",
      "active business channel closed",
    );
    assert(
      !first.remote() && !track.enabled,
      "media revoked",
    );
    await first.sessionB.sendMessage(
      createSessionMessage(first.sessionB, "send-text", {
        data: "denied",
      }),
    );
    // A discovery frame on the same ordered channel confirms prior delivery was processed.
    await first.sessionB.sendMessage(
      createSessionMessage(
        first.sessionB,
        "peer-capabilities",
        {
          update: {
            kind: "snapshot",
            generation: "check",
            revision: 1,
            services: {},
          },
        },
      ),
    );
    await new Promise((r) => setTimeout(r, 100));
    assert(
      !first.received.includes("denied"),
      "all received content blocked",
    );
    assert(
      first.sessionA.isMessageChannelReady,
      "bootstrap connection remains",
    );
    first.receiveA[1](true);
    await until(
      () =>
        !!first.remote()?.getVideoTracks().length &&
        track.enabled,
      "media restored",
    );
    await first.sessionB.sendMessage(
      createSessionMessage(first.sessionB, "send-text", {
        data: "restored",
      }),
    );
    await until(
      () => first.received.includes("restored"),
      "messages restored",
    );
    first.sessionB.close();
    await until(
      () => !first.trustA.trusted("b"),
      "authority withdrawn on disconnect",
    );
    assert(
      pinsA.get("b")?.blocked === false,
      "normal disconnect must not quarantine the pin",
    );
  } finally {
    first.close();
    clearInterval(draw);
    stream.getTracks().forEach((t) => t.stop());
  }
  // Only the peer-issued key survives: recover our missing pin, keypair and
  // issuance record while the peer also renews its expired issuance.
  const oldB = keysB.get("a")!.issued!.id;
  keysB.get("a")!.issued!.expiresAt = Date.now() - 1;
  keysA.set("b", { received: keysA.get("b")!.received });
  pinsA.delete("b");
  const recoveredIdentity = await newIdentity();
  const recovered = await connection(
    recoveredIdentity,
    b,
    pinsA,
    pinsB,
    keysA,
    keysB,
    true,
  );
  try {
    assert(
      recovered.trustA.trusted("b") &&
        recovered.trustB.trusted("a"),
      "automatic trust recovery",
    );
    assert(
      recovered.receiveA[0]() && recovered.receiveB[0](),
      "automatic recovery preserves permissions",
    );
    await until(
      keysSettled,
      "issuer-driven replacement after recovery",
    );
    assert(
      keysB.get("a")!.issued!.id !== oldB,
      "expired key rotated by issuer",
    );
  } finally {
    recovered.close();
  }
  // The replacement has lost every record; the remembered peer must not be
  // mistaken for a new connection just because this side has an empty store.
  const replacementKeys = new Map<
    string,
    PairingCredentials
  >();
  const changed = await connection(
    recoveredIdentity,
    await newIdentity(),
    pinsA,
    new Map(),
    keysA,
    replacementKeys,
  );
  try {
    assert(
      changed.trustA.get("b")?.state === "untrusted",
      "changed key quarantined",
    );
    assert(
      changed.trustB.get("a")?.state === "untrusted" &&
        !changed.receiveB[0](),
      "empty profile does not auto-pair with a remembered peer",
    );
    assert(
      changed.sessionA.isMessageChannelReady,
      "changed key keeps RTC connection",
    );
    assert(
      !changed.receiveA[0](),
      "changed key revokes permissions",
    );
    const proof = changed.trustA.get("b")!;
    const replacementProof = changed.trustB.get("a")!;
    await Promise.all([
      changed.trustA.pair(
        "b",
        proof.fingerprint!,
        proof.code!,
      ),
      changed.trustB.pair(
        "a",
        replacementProof.fingerprint!,
        replacementProof.code!,
      ),
    ]);
    assert(
      changed.trustA.trusted("b") && changed.receiveA[0](),
      "repair restores default permissions",
    );
    await until(
      () =>
        !!keysA.get("b")?.issued &&
        !!replacementKeys.get("a")?.issued &&
        keysA.get("b")?.received?.id ===
          replacementKeys.get("a")?.issued?.id &&
        replacementKeys.get("a")?.received?.id ===
          keysA.get("b")?.issued?.id,
      "repaired devices exchange fresh keys",
    );
  } finally {
    changed.close();
  }
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    transport: "Chromium real WebRTC",
    persistentPrivateKey: true,
    automaticFirstPairing: true,
    bothSidesRejectLostRecords: true,
    pairingRestoresDefaults: true,
    keyMismatchQuarantine: true,
    manualRepair: true,
    messageRevocation: true,
    channelRevocation: true,
    mediaRevocationAndRestore: true,
    normalDisconnectPreservesPin: true,
    pairingKeyPersistence: true,
    automaticKeyRecovery: true,
    expiredKeyRenewal: true,
    automaticRecoveryPreservesPermissions: true,
    interruptedFirstExchangeResume: true,
  };
}
void main().catch(
  (error) =>
    (window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error)),
);
