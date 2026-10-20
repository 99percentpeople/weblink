// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { webcrypto } from "node:crypto";
import { PeerTrustService } from "@/libs/application/peer-trust";
import {
  deviceIdentity,
  fingerprint,
  type DeviceIdentity,
} from "@/libs/domain/device-identity/crypto";
import {
  CREDENTIAL_LIFETIME,
  type PairingCredentials,
} from "@/libs/domain/device-identity/credentials";
import type {
  DeviceIdentityStore,
  DevicePin,
} from "@/libs/infrastructure/identity/device-identity-store";
import type { PeerSession } from "@/libs/domain/session";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";

class Channel extends EventTarget {
  readyState = "open";
  label = "weblink-device-identity/1";
  protocol = this.label;
  other!: Channel;
  frames: Record<string, any>[] = [];
  filter: (
    frame: Record<string, any>,
  ) => Record<string, any> | undefined = (v) => v;
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    const result = this.filter(frame);
    if (result)
      queueMicrotask(() => {
        if (this.other.readyState === "open")
          this.other.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(result),
            }),
          );
      });
  }
  close() {
    this.readyState = "closed";
  }
}
const cleanup: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const newIdentity = async () =>
  deviceIdentity(
    await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  );
async function endpoint() {
  let identity = await newIdentity();
  let pin: DevicePin | undefined;
  let keys: PairingCredentials = {};
  let failWrites = false;
  const store: DeviceIdentityStore = {
    identity: async () => identity,
    pin: async () => structuredClone(pin),
    save: async (_, value) => {
      pin = structuredClone(value);
    },
    pair: async (_, value) => {
      if (failWrites)
        throw new Error("Storage unavailable");
      pin = structuredClone(value);
      keys = {};
    },
    credentials: () => ({
      read: async () => structuredClone(keys),
      update: async (change) => {
        if (failWrites)
          throw new Error("Storage unavailable");
        keys = structuredClone(
          change(structuredClone(keys)),
        );
        if (pin && (keys.issued || keys.received))
          pin = { ...pin, credentialRequired: true };
        return structuredClone(keys);
      },
    }),
  };
  return {
    store,
    get keys() {
      return keys;
    },
    set keys(value) {
      keys = value;
    },
    get pin() {
      return pin;
    },
    set pin(value) {
      pin = value;
    },
    set identity(value: DeviceIdentity) {
      identity = value;
    },
    set failWrites(value: boolean) {
      failWrites = value;
    },
  };
}
type Endpoint = Awaited<ReturnType<typeof endpoint>>;
async function connect(
  a: Endpoint,
  b: Endpoint,
  filterB?: Channel["filter"],
) {
  const left = new Channel(),
    right = new Channel();
  left.other = right;
  right.other = left;
  if (filterB) right.filter = filterB;
  const resetA = vi.fn(),
    resetB = vi.fn();
  const pairedA = vi.fn(),
    pairedB = vi.fn();
  const trustA = new PeerTrustService(
      { quarantine: resetA, paired: pairedA },
      a.store,
    ),
    trustB = new PeerTrustService(
      { quarantine: resetB, paired: pairedB },
      b.store,
    );
  const events = new MultiEventEmitter<any>();
  const eventsA = new MultiEventEmitter<any>();
  const sdp = `a=fingerprint:sha-256 ${Array(32).fill("ab").join(":")}`;
  const common = {
    isMessageChannelReady: true,
    peerConnection: {
      localDescription: { sdp },
      remoteDescription: { sdp },
    },
  };
  const offB = trustB.bind({
    ...common,
    clientId: "b",
    targetClientId: "a",
    addEventListener: events.addEventListener.bind(events),
  } as unknown as PeerSession);
  const offA = trustA.bind({
    ...common,
    clientId: "a",
    targetClientId: "b",
    addEventListener:
      eventsA.addEventListener.bind(eventsA),
    createChannel: async () => {
      events.dispatchEvent(
        "channel",
        right as unknown as RTCDataChannel,
      );
      return left;
    },
  } as unknown as PeerSession);
  const close = () => {
    offA();
    offB();
  };
  cleanup.push(close);
  await vi.waitFor(() => {
    expect(trustA.get("b")?.code).toBeTruthy();
    expect(trustB.get("a")?.code).toBeTruthy();
  });
  return {
    trustA,
    trustB,
    resetA,
    resetB,
    pairedA,
    pairedB,
    left,
    right,
    close,
  };
}
async function settled(a: Endpoint, b: Endpoint) {
  await vi.waitFor(() => {
    expect(a.keys.issued).toBeDefined();
    expect(b.keys.issued).toBeDefined();
    expect(a.keys.received?.id).toBe(b.keys.issued?.id);
    expect(b.keys.received?.id).toBe(a.keys.issued?.id);
    expect(a.keys.pending).toBeUndefined();
    expect(b.keys.pending).toBeUndefined();
  });
}
async function paired() {
  const a = await endpoint(),
    b = await endpoint();
  const h = await connect(a, b);
  expect(h.trustA.trusted("b")).toBe(true);
  expect(h.trustB.trusted("a")).toBe(true);
  expect(h.pairedA).toHaveBeenCalledOnce();
  expect(h.pairedB).toHaveBeenCalledOnce();
  await settled(a, b);
  return { a, b, h };
}
function preserved(h: Awaited<ReturnType<typeof connect>>) {
  expect(h.trustA.trusted("b")).toBe(true);
  expect(h.trustB.trusted("a")).toBe(true);
  expect(h.resetA).not.toHaveBeenCalled();
  expect(h.resetB).not.toHaveBeenCalled();
  expect(h.pairedA).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
}
it.each(["all", "offer", "ack"])(
  "resumes the first exchange after losing %s credential traffic without resetting permissions",
  async (lost) => {
    const a = await endpoint(),
      b = await endpoint();
    const h = await connect(a, b, (frame) =>
      (
        lost === "all"
          ? frame.kind.startsWith("credential-")
          : frame.kind === `credential-${lost}`
      )
        ? undefined
        : frame,
    );
    await vi.waitFor(() =>
      expect(b.keys.pending ?? b.keys.issued).toBeDefined(),
    );
    expect(h.trustA.trusted("b")).toBe(true);
    expect(h.trustB.trusted("a")).toBe(true);
    h.close();
    const again = await connect(a, b);
    await settled(a, b);
    preserved(again);
    expect(a.pin?.credentialRequired).toBe(true);
    expect(b.pin?.credentialRequired).toBe(true);
  },
);
it("does not accept a changed signing identity while the first exchange is incomplete", async () => {
  const a = await endpoint(),
    b = await endpoint();
  const h = await connect(a, b, (frame) =>
    frame.kind.startsWith("credential-")
      ? undefined
      : frame,
  );
  h.close();
  b.identity = await newIdentity();
  const attack = await connect(a, b);
  expect(attack.trustA.get("b")?.state).toBe("untrusted");
  expect(attack.resetA).toHaveBeenCalledOnce();
  expect(
    attack.left.frames.some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
});
it("automatically pairs first-use devices and exchanges two independent pairing keys", async () => {
  const { a, b, h } = await paired();
  expect(a.keys.issued?.id).not.toBe(b.keys.issued?.id);
  expect(a.keys.issued?.expiresAt).toBeGreaterThan(
    Date.now() + CREDENTIAL_LIFETIME - 10000,
  );
  expect(a.pin?.credentialRequired).toBe(true);
  h.close();
  const again = await connect(a, b);
  preserved(again);
});
it("automatically reissues a lost issuer record using the key received from the peer", async () => {
  const { a, b, h } = await paired();
  h.close();
  const oldA = a.keys.issued!.id,
    oldB = b.keys.issued!.id;
  a.keys = { received: a.keys.received };
  const again = await connect(a, b);
  await settled(a, b);
  preserved(again);
  expect(a.keys.issued!.id).not.toBe(oldA);
  expect(b.keys.issued!.id).toBe(oldB);
});
it("recovers a missing public pin and regenerated local identity through the surviving issued key", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.keys = { received: a.keys.received };
  a.pin = undefined;
  a.identity = await newIdentity();
  const oldPeerPin = b.pin!.fingerprint;
  const again = await connect(a, b);
  await settled(a, b);
  preserved(again);
  expect((await a.store.pin("b"))?.blocked).toBe(false);
  expect(b.pin!.fingerprint).not.toBe(oldPeerPin);
});
it("lets the original issuer replace a received key lost by the other device", async () => {
  const { a, b, h } = await paired();
  h.close();
  const oldA = a.keys.issued!.id,
    oldB = b.keys.issued!.id;
  a.keys = { issued: a.keys.issued };
  const again = await connect(a, b);
  await settled(a, b);
  preserved(again);
  expect(a.keys.issued!.id).toBe(oldA);
  expect(b.keys.issued!.id).not.toBe(oldB);
});
it("migrates already confirmed public pins into pairing keys without losing permissions", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin!.credentialRequired = false;
  b.pin!.credentialRequired = false;
  a.keys = {};
  b.keys = {};
  const again = await connect(a, b);
  await settled(a, b);
  preserved(again);
  expect(a.pin!.credentialRequired).toBe(true);
  expect(b.pin!.credentialRequired).toBe(true);
});
it("retains offline expired keys for proof and lets only their issuer renew them", async () => {
  const { a, b, h } = await paired();
  h.close();
  const oldA = a.keys.issued!.id,
    oldB = b.keys.issued!.id;
  a.keys.issued!.expiresAt =
    Date.now() - CREDENTIAL_LIFETIME;
  b.keys.received!.expiresAt = a.keys.issued!.expiresAt;
  const again = await connect(a, b);
  await settled(a, b);
  preserved(again);
  expect(a.keys.issued!.id).not.toBe(oldA);
  expect(b.keys.issued!.id).toBe(oldB);
});
it("automatically renews while connected when the issuing clock reaches expiry", async () => {
  const { a, b, h } = await paired();
  h.close();
  const oldA = a.keys.issued!.id;
  a.keys.issued!.expiresAt = Date.now() + 250;
  b.keys.received!.expiresAt = a.keys.issued!.expiresAt;
  const again = await connect(a, b);
  await vi.waitFor(() =>
    expect(a.keys.issued!.id).not.toBe(oldA),
  );
  await settled(a, b);
  preserved(again);
});
it("resumes a persisted offer after a lost ACK, even when it is the only surviving key", async () => {
  const { a, b, h } = await paired();
  h.close();
  const old = a.keys.issued!;
  old.expiresAt = Date.now() - 1;
  const interrupted = await connect(a, b, (frame) =>
    frame.kind === "credential-ack" ? undefined : frame,
  );
  await vi.waitFor(() => {
    expect(a.keys.pending).toBeDefined();
    expect(b.keys.received?.id).toBe(a.keys.pending?.id);
  });
  const pending = a.keys.pending!.id;
  expect(a.keys.issued?.id).toBe(old.id);
  preserved(interrupted);
  interrupted.close();
  a.keys = { pending: a.keys.pending };
  b.keys = { received: b.keys.received };
  const resumed = await connect(a, b);
  await settled(a, b);
  preserved(resumed);
  expect(a.keys.issued?.id).toBe(pending);
});
it("keeps old keys and trust when the receiver cannot persist the replacement", async () => {
  const { a, b, h } = await paired();
  h.close();
  const old = a.keys.issued!.id;
  a.keys.issued!.expiresAt = Date.now() - 1;
  b.failWrites = true;
  const failed = await connect(a, b);
  await vi.waitFor(() =>
    expect(a.keys.pending).toBeDefined(),
  );
  expect(a.keys.issued!.id).toBe(old);
  expect(b.keys.received!.id).toBe(old);
  preserved(failed);
  failed.close();
  b.failWrites = false;
  const resumed = await connect(a, b);
  await settled(a, b);
  preserved(resumed);
  expect(a.keys.issued!.id).not.toBe(old);
});
it("does not use a remembered public pin to bypass missing pairing keys", async () => {
  const { a, b, h } = await paired();
  h.close();
  b.keys = {};
  const missing = await connect(a, b);
  expect(missing.trustA.get("b")?.state).toBe("untrusted");
  expect(missing.trustB.get("a")?.state).toBe("untrusted");
  expect(missing.resetA).toHaveBeenCalledOnce();
  expect(missing.resetB).toHaveBeenCalledOnce();
  expect(
    missing.left.frames.some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
});
it.each(["a", "b"] as const)(
  "requires repair on both devices when %s loses all pairing records",
  async (side) => {
    const { a, b, h } = await paired();
    h.close();
    const lost = side === "a" ? a : b;
    lost.pin = undefined;
    lost.keys = {};
    const again = await connect(a, b);
    expect(again.trustA.get("b")?.state).toBe("untrusted");
    expect(again.trustB.get("a")?.state).toBe("untrusted");
    expect(again.pairedA).not.toHaveBeenCalled();
    expect(again.pairedB).not.toHaveBeenCalled();
    expect(a.keys.blocked).toBe(true);
    expect(b.keys.blocked).toBe(true);
    expect(
      [...again.left.frames, ...again.right.frames].some(
        (frame) => frame.kind.startsWith("credential-"),
      ),
    ).toBe(false);
    // An explicit review on each side can restore defaults and exchange fresh keys.
    const proofA = again.trustA.get("b")!;
    const proofB = again.trustB.get("a")!;
    await Promise.all([
      again.trustA.pair(
        "b",
        proofA.fingerprint!,
        proofA.code!,
      ),
      again.trustB.pair(
        "a",
        proofB.fingerprint!,
        proofB.code!,
      ),
    ]);
    await settled(a, b);
    expect(again.pairedA).toHaveBeenCalledOnce();
    expect(again.pairedB).toHaveBeenCalledOnce();
  },
);

it("does not automatically pair a fresh profile with a quarantined peer that has no keys", async () => {
  const a = await endpoint(),
    b = await endpoint();
  b.keys = { blocked: true };
  const h = await connect(a, b);
  expect(h.trustA.get("b")?.state).toBe("untrusted");
  expect(h.trustB.get("a")?.state).toBe("untrusted");
  expect(h.pairedA).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
});

it("finishes first pairing after interruption between the two initial pin commits", async () => {
  const a = await endpoint(),
    b = await endpoint();
  b.pin = {
    fingerprint: await fingerprint(
      (await a.store.identity()).publicKey,
    ),
    blocked: false,
  };
  const h = await connect(a, b);
  await settled(a, b);
  expect(h.trustA.trusted("b")).toBe(true);
  expect(h.trustB.trusted("a")).toBe(true);
  expect(h.pairedA).toHaveBeenCalledOnce();
  expect(h.pairedB).not.toHaveBeenCalled();
  expect(h.resetA).not.toHaveBeenCalled();
  expect(h.resetB).not.toHaveBeenCalled();
});
it("rejects a credential proof replayed into a new connection even with a valid device signature", async () => {
  const { a, b, h } = await paired();
  h.close();
  const original = await connect(a, b);
  const proof = original.right.frames.find(
    (f) => f.kind === "proof",
  )!;
  original.close();
  const replay = await connect(a, b, (f) =>
    f.kind === "proof"
      ? { ...f, credentialProofs: proof.credentialProofs }
      : f,
  );
  expect(replay.trustA.get("b")?.state).toBe("untrusted");
  expect(replay.resetA).toHaveBeenCalledOnce();
});
it("quarantines a failed key proof even when the public pin was lost", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin = undefined;
  b.keys = {};
  const missing = await connect(a, b);
  expect(missing.trustA.get("b")?.state).toBe("untrusted");
  expect(a.keys.blocked).toBe(true);
});
it("cannot automatically restore explicitly quarantined keys", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin!.blocked = true;
  const again = await connect(a, b);
  expect(again.trustA.get("b")?.state).toBe("untrusted");
  expect(a.keys.blocked).toBe(true);
  const old = a.keys.issued!.id;
  const proof = again.trustA.get("b")!;
  await again.trustA.pair(
    "b",
    proof.fingerprint!,
    proof.code!,
  );
  await settled(a, b);
  expect(a.keys.issued!.id).not.toBe(old);
  expect(again.resetA).toHaveBeenCalledOnce();
  expect(again.pairedA).toHaveBeenCalledOnce();
});
