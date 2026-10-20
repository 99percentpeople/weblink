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
import { bindCredential } from "@/libs/domain/device-identity/credential-binding";
import { PAIRING_CHANNEL } from "@/libs/domain/device-identity/manual-pairing";
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
  vi.useRealTimers();
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
      if (failWrites)
        throw new Error("Storage unavailable");
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
    get identity() {
      return identity;
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
  filterA?: Channel["filter"],
  waitForBoth = true,
) {
  const left = new Channel(),
    right = new Channel();
  left.other = right;
  right.other = left;
  if (filterB) right.filter = filterB;
  if (filterA) left.filter = filterA;
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
  const channels: Channel[] = [left, right];
  let initial = true;
  const create =
    (fromA: boolean) =>
    async (
      label: string,
      protocol: string,
      onAvailable?: (channel: RTCDataChannel) => void,
    ) => {
      const local = initial && fromA ? left : new Channel();
      const remote =
        initial && fromA ? right : new Channel();
      if (!initial || !fromA) channels.push(local, remote);
      initial = false;
      local.other = remote;
      remote.other = local;
      local.label = remote.label = label;
      local.protocol = remote.protocol = protocol;
      local.filter =
        (fromA ? filterA : filterB) ?? ((v) => v);
      remote.filter =
        (fromA ? filterB : filterA) ?? ((v) => v);
      onAvailable?.(local as unknown as RTCDataChannel);
      (fromA ? events : eventsA).dispatchEvent(
        "channel",
        remote as unknown as RTCDataChannel,
      );
      return local as unknown as RTCDataChannel;
    };
  const sessionB = {
    ...common,
    clientId: "b",
    targetClientId: "a",
    addEventListener: events.addEventListener.bind(events),
    createChannel: create(false),
  } as unknown as PeerSession;
  const sessionA = {
    ...common,
    clientId: "a",
    targetClientId: "b",
    addEventListener:
      eventsA.addEventListener.bind(eventsA),
    createChannel: create(true),
  } as unknown as PeerSession;
  const offB = trustB.bind(sessionB);
  const offA = trustA.bind(sessionA);
  const close = () => {
    offA();
    offB();
  };
  cleanup.push(close);
  await vi.waitFor(() => {
    expect(trustA.get("b")?.state).not.toBe("verifying");
    if (waitForBoth)
      expect(trustB.get("a")?.state).not.toBe("verifying");
  });
  return {
    trustA,
    trustB,
    sessionA,
    sessionB,
    eventsA,
    eventsB: events,
    channels,
    resetA,
    resetB,
    pairedA,
    pairedB,
    left,
    right,
    close,
  };
}
async function repair(
  h: Awaited<ReturnType<typeof connect>>,
) {
  await h.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.state).toBe("incoming"),
  );
  expect(
    h.trustB.respondPairing(
      "a",
      h.trustB.pairing("a")!.id,
      true,
    ),
  ).toBe(true);
  await vi.waitFor(() => {
    expect(h.trustA.trusted("b")).toBe(true);
    expect(h.trustB.trusted("a")).toBe(true);
  });
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
async function setExpiry(
  a: Endpoint,
  b: Endpoint,
  expiresAt: number,
) {
  const issued = a.keys.issued!;
  issued.expiresAt = expiresAt;
  issued.binding = await bindCredential(issued, {
    identity: a.identity,
    client: "a",
    target: "b",
    remoteKey: b.identity.publicKey,
  });
  if (b.keys.received?.id === issued.id)
    b.keys.received = structuredClone(issued);
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
it("resumes both initial key exchanges from confirmed pins without losing permissions", async () => {
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
  await setExpiry(a, b, Date.now() - CREDENTIAL_LIFETIME);
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
  await setExpiry(a, b, Date.now() + 500);
  const again = await connect(a, b);
  // A valid signed issuance must survive the handshake until its deadline.
  expect(a.keys.issued!.id).toBe(oldA);
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
  await setExpiry(a, b, Date.now() - 1);
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
  await setExpiry(a, b, Date.now() - 1);
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
it("recovers missing pairing keys using both retained identity pins", async () => {
  const { a, b, h } = await paired();
  h.close();
  b.keys = {};
  const recovered = await connect(a, b);
  await settled(a, b);
  preserved(recovered);
});
it.each(["a", "b"] as const)(
  "recovers both directions when %s loses all peer records but retains its identity",
  async (side) => {
    const { a, b, h } = await paired();
    h.close();
    const lost = side === "a" ? a : b;
    lost.pin = undefined;
    lost.keys = {};
    const again = await connect(a, b);
    await settled(a, b);
    preserved(again);
    expect(a.pin?.fingerprint).toBe(
      await fingerprint(b.identity.publicKey),
    );
    expect(b.pin?.fingerprint).toBe(
      await fingerprint(a.identity.publicKey),
    );
    expect(a.keys.issued?.binding).toBeDefined();
    expect(b.keys.issued?.binding).toBeDefined();
    const recoveryFrames = [
      ...again.left.frames,
      ...again.right.frames,
    ].filter((frame) => frame.kind === "proof");
    expect(
      recoveryFrames.some((frame) => frame.recoveryBinding),
    ).toBe(true);
    expect(JSON.stringify(recoveryFrames)).not.toContain(
      '"secret":',
    );
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
it("uses a locally signed issuance to recover a lost pin while the other side lost its keys", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin = undefined;
  b.keys = {};
  const recovered = await connect(a, b);
  await settled(a, b);
  preserved(recovered);
});
it("cannot automatically restore explicitly quarantined keys", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin!.blocked = true;
  const again = await connect(a, b);
  expect(again.trustA.get("b")?.state).toBe("untrusted");
  expect(a.keys.blocked).toBe(true);
  const old = a.keys.issued!.id;
  await repair(again);
  await settled(a, b);
  expect(a.keys.issued!.id).not.toBe(old);
  expect(again.resetA).toHaveBeenCalledOnce();
  expect(again.pairedA).toHaveBeenCalledOnce();
});

it("recovers when both devices lost their pairing keys but retained their identity pins", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.keys = {};
  b.keys = {};
  const recovered = await connect(a, b);
  await settled(a, b);
  preserved(recovered);
});

it.each(["a", "b"] as const)(
  "rejects %s after losing both its identity and every peer record",
  async (side) => {
    const { a, b, h } = await paired();
    h.close();
    const lost = side === "a" ? a : b;
    lost.keys = {};
    lost.pin = undefined;
    lost.identity = await newIdentity();
    const attack = await connect(a, b);
    expect(attack.trustA.get("b")?.state).toBe("untrusted");
    expect(attack.trustB.get("a")?.state).toBe("untrusted");
    expect(
      [...attack.left.frames, ...attack.right.frames].some(
        (f) => f.kind === "credential-offer",
      ),
    ).toBe(false);
  },
);

it.each(["pin", "keys"] as const)(
  "does not use identity recovery to clear a quarantined %s",
  async (record) => {
    const { a, b, h } = await paired();
    h.close();
    if (record === "pin") a.pin!.blocked = true;
    else a.keys.blocked = true;
    b.pin = undefined;
    b.keys = {};
    const attack = await connect(a, b);
    expect(attack.trustA.get("b")?.state).toBe("untrusted");
    expect(attack.trustB.get("a")?.state).toBe("untrusted");
    expect(attack.pairedA).not.toHaveBeenCalled();
    expect(attack.pairedB).not.toHaveBeenCalled();
  },
);

it.each(["change", "remove", "invalid"] as const)(
  "rejects a %s to the signed missing-key recovery declaration",
  async (mode) => {
    const { a, b, h } = await paired();
    h.close();
    b.keys = {};
    const attack = await connect(
      a,
      b,
      (frame) =>
        frame.kind === "hello"
          ? {
              ...frame,
              recovery:
                mode === "change"
                  ? "ready"
                  : mode === "remove"
                    ? undefined
                    : true,
            }
          : frame,
      undefined,
      mode === "change",
    );
    expect(attack.trustA.get("b")?.state).toBe("untrusted");
    expect(
      attack.left.frames.some(
        (f) => f.kind === "credential-offer",
      ),
    ).toBe(false);
  },
);

it.each([
  "signature",
  "recipientKey",
  "secretHash",
  "expiresAt",
] as const)(
  "rejects tampered recovery binding %s before granting authority",
  async (field) => {
    const { a, b, h } = await paired();
    h.close();
    a.pin = undefined;
    a.keys = {};
    const attack = await connect(a, b, (frame) => {
      if (frame.kind !== "proof") return frame;
      const certificate = structuredClone(
        frame.recoveryBinding,
      );
      if (field === "expiresAt") certificate.expiresAt += 1;
      else
        certificate.binding[field] =
          "A".repeat(field === "secretHash" ? 43 : 87) +
          "=";
      return { ...frame, recoveryBinding: certificate };
    });
    expect(attack.trustA.get("b")?.state).toBe("untrusted");
    expect(attack.pairedA).not.toHaveBeenCalled();
    expect(
      attack.left.frames.some((f) =>
        f.kind.startsWith("credential-"),
      ),
    ).toBe(false);
  },
);

it("a stolen historical binding cannot authenticate a different signing identity", async () => {
  const { a, b, h } = await paired();
  h.close();
  const { secret: _secret, ...certificate } =
    b.keys.received!;
  a.pin = undefined;
  a.keys = {};
  b.identity = await newIdentity();
  const attack = await connect(a, b, (frame) =>
    frame.kind === "proof"
      ? { ...frame, recoveryBinding: certificate }
      : frame,
  );
  expect(attack.trustA.get("b")?.state).toBe("untrusted");
  expect(
    attack.left.frames.some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
});

it("a previously valid recovery signature cannot be replayed on a fresh connection", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.pin = undefined;
  a.keys = {};
  const recovered = await connect(a, b);
  await settled(a, b);
  const proof = recovered.right.frames.find(
    (f) => f.kind === "proof",
  )!;
  recovered.close();
  a.pin = undefined;
  a.keys = {};
  const attack = await connect(a, b, (frame) =>
    frame.kind === "proof" ? proof : frame,
  );
  expect(attack.trustA.get("b")?.state).toBe("untrusted");
  expect(
    attack.left.frames.some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
});

it("does not treat invalid persisted credential bindings as missing keys or silently upgrade them", async () => {
  const { a, b, h } = await paired();
  h.close();
  b.keys.received!.binding.signature = "";
  a.keys = {};
  a.pin = undefined;
  const missing = await connect(a, b);
  expect(missing.trustA.get("b")?.state).toBe("untrusted");
  expect(missing.trustB.get("a")?.state).toBe("untrusted");
  expect(
    [...missing.left.frames, ...missing.right.frames].some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
  await repair(missing);
  await settled(a, b);
  expect(missing.pairedA).toHaveBeenCalledOnce();
  expect(missing.pairedB).toHaveBeenCalledOnce();
});

it("retains identity recovery across a disconnect before new keys can be stored", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.keys = {};
  a.pin = undefined;
  // Recover the pin, then simulate failure of the key transaction.
  const save = a.store.save.bind(a.store);
  a.store.save = async (...args) => {
    await save(...args);
    a.failWrites = true;
  };
  const interrupted = await connect(a, b);
  preserved(interrupted);
  await vi.waitFor(() =>
    expect(b.keys.pending).toBeDefined(),
  );
  expect(a.keys.received).toBeUndefined();
  const pending = b.keys.pending!.id;
  interrupted.close();
  a.store.save = save;
  a.failWrites = false;
  const resumed = await connect(a, b);
  await settled(a, b);
  preserved(resumed);
  expect(b.keys.issued!.id).toBe(pending);
});

it("never falls back to identity recovery after a known pairing key has a wrong MAC", async () => {
  const { a, b, h } = await paired();
  h.close();
  const original = await connect(a, b);
  const stale = original.right.frames.find(
    (f) => f.kind === "proof",
  )!.credentialProofs;
  original.close();
  b.keys = {};
  const attack = await connect(a, b, (frame) =>
    frame.kind === "proof"
      ? { ...frame, credentialProofs: stale }
      : frame,
  );
  expect(attack.trustA.get("b")?.state).toBe("untrusted");
  expect(
    attack.left.frames.some(
      (f) => f.kind === "credential-offer",
    ),
  ).toBe(false);
});

it("checks that a received key actually matches its signed secret hash", async () => {
  const { a, b, h } = await paired();
  h.close();
  a.keys = {};
  const attack = await connect(a, b, (frame) =>
    frame.kind === "credential-offer"
      ? {
          ...frame,
          credential: {
            ...frame.credential,
            secret: "A".repeat(43) + "=",
          },
        }
      : frame,
  );
  await vi.waitFor(() =>
    expect(attack.trustA.get("b")?.state).toBe("untrusted"),
  );
  expect(a.keys.received).toBeUndefined();
  expect(
    attack.left.frames.some(
      (f) => f.kind === "credential-ack",
    ),
  ).toBe(false);
});

async function quarantined() {
  const { a, b, h } = await paired();
  h.close();
  a.pin!.blocked = b.pin!.blocked = true;
  return { a, b };
}

it("can manually repair after an invalid identity signature, then reconnect through normal authenticated recovery", async () => {
  const { a, b } = await quarantined();
  const h = await connect(
    a,
    b,
    (f) =>
      f.kind === "proof"
        ? { ...f, signature: "invalid" }
        : f,
    undefined,
    false,
  );
  expect(h.trustA.get("b")).toEqual({ state: "untrusted" });
  await repair(h);
  await settled(a, b);
  expect(h.pairedA).toHaveBeenCalledOnce();
  expect(h.pairedB).toHaveBeenCalledOnce();
  h.close();
  const again = await connect(a, b);
  preserved(again);
});

it("supports initiation from either device and preserves permissions until the other device approves", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  const savedA = structuredClone(a.keys),
    savedB = structuredClone(b.keys);
  await h.trustB.requestPairing("a");
  await vi.waitFor(() =>
    expect(h.trustA.pairing("b")?.state).toBe("incoming"),
  );
  expect(a.keys).toEqual(savedA);
  expect(b.keys).toEqual(savedB);
  expect(h.pairedA).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
  expect(
    h.trustA.respondPairing(
      "b",
      h.trustA.pairing("b")!.id,
      true,
    ),
  ).toBe(true);
  await settled(a, b);
  await vi.waitFor(() => {
    expect(h.trustA.trusted("b")).toBe(true);
    expect(h.trustB.trusted("a")).toBe(true);
  });
  expect(a.keys.issued?.id).not.toBe(savedA.issued?.id);
});

it("rejecting a request does not reset a still-trusted recipient's saved policy", async () => {
  const { a, b, h: original } = await paired();
  original.close();
  a.pin!.blocked = true;
  const h = await connect(a, b);
  expect(h.trustB.trusted("a")).toBe(true);
  const keys = structuredClone(b.keys);
  await h.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.state).toBe("incoming"),
  );
  expect(
    h.trustB.respondPairing(
      "a",
      h.trustB.pairing("a")!.id,
      false,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(h.trustA.pairing("b")?.reason).toBe("rejected"),
  );
  expect(h.trustB.trusted("a")).toBe(true);
  expect(h.resetB).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
  expect(b.keys).toEqual(keys);
});

it("disconnect removes approval actions and a duplicate ID cannot replace a real device", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  await h.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.state).toBe("incoming"),
  );
  const stale = h.trustB.pairing("a")!.id;
  expect(() => h.trustB.bind(h.sessionB)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  expect(h.trustB.pairing("a")?.id).toBe(stale);
  h.eventsB.dispatchEvent("messagechannelchange", "closed");
  expect(h.trustB.pairing("a")).toBeUndefined();
  expect(h.trustB.respondPairing("a", stale, true)).toBe(
    false,
  );
  expect(h.pairedA).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
  h.close();
  const next = await connect(a, b);
  await next.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(next.trustB.pairing("a")?.state).toBe(
      "incoming",
    ),
  );
  expect(next.trustB.respondPairing("a", stale, true)).toBe(
    false,
  );
  expect(next.trustB.trusted("a")).toBe(false);
});

it("keeps a committed manual decision across disconnect without activating stale live authority", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  let release!: () => void;
  const pair = b.store.pair;
  vi.spyOn(b.store, "pair").mockImplementationOnce(
    async (id, pin) => {
      await new Promise<void>((r) => {
        release = r;
      });
      await pair(id, pin);
    },
  );
  await h.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.state).toBe("incoming"),
  );
  h.trustB.respondPairing(
    "a",
    h.trustB.pairing("a")!.id,
    true,
  );
  await vi.waitFor(() => expect(release).toBeDefined());
  h.close();
  release();
  await vi.waitFor(() =>
    expect(h.pairedB).toHaveBeenCalledOnce(),
  );
  expect(b.pin?.blocked).toBe(false);
  expect(h.trustB.trusted("a")).toBe(false);
  expect(h.trustA.trusted("b")).toBe(false);
  const again = await connect(a, b);
  preserved(again);
});

it("a failed manual commit cannot grant live permissions or emit new credentials", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  b.failWrites = true;
  await h.trustA.requestPairing("b");
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.state).toBe("incoming"),
  );
  h.trustB.respondPairing(
    "a",
    h.trustB.pairing("a")!.id,
    true,
  );
  await vi.waitFor(() =>
    expect(h.trustB.pairing("a")?.reason).toBe("storage"),
  );
  expect(h.trustA.trusted("b")).toBe(false);
  expect(h.trustB.trusted("a")).toBe(false);
  expect(h.pairedB).not.toHaveBeenCalled();
  expect(
    h.channels
      .filter((c) => c.protocol === PAIRING_CHANNEL)
      .flatMap((c) => c.frames)
      .some((f) => f.kind === "credential-offer"),
  ).toBe(false);
});

it("cancels a channel creation that stalls and rejects its late channel", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  let available!: (channel: RTCDataChannel) => void;
  let release!: (channel: RTCDataChannel) => void;
  vi.spyOn(
    h.sessionA,
    "createChannel",
  ).mockImplementationOnce((_, __, callback) => {
    available = callback!;
    return new Promise((r) => {
      release = r;
    });
  });
  const request = h.trustA.requestPairing("b");
  const id = h.trustA.pairing("b")!.id;
  expect(h.trustA.cancelPairing("b", id)).toBe(true);
  const channel = new Channel();
  available(channel as unknown as RTCDataChannel);
  release(channel as unknown as RTCDataChannel);
  await request;
  expect(channel.readyState).toBe("closed");
  expect(h.trustA.pairing("b")?.reason).toBe("cancelled");
  expect(h.pairedA).not.toHaveBeenCalled();
});

it("simultaneous requests cannot replace each other's pending approval or grant authority", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  const localA = new Channel(),
    remoteB = new Channel();
  const localB = new Channel(),
    remoteA = new Channel();
  localA.other = remoteB;
  remoteB.other = localA;
  localB.other = remoteA;
  remoteA.other = localB;
  for (const channel of [localA, remoteB, localB, remoteA])
    channel.label = channel.protocol = PAIRING_CHANNEL;
  const createA = vi
    .spyOn(h.sessionA, "createChannel")
    .mockImplementationOnce(async (_, __, available) => {
      available?.(localA as unknown as RTCDataChannel);
      return localA as unknown as RTCDataChannel;
    });
  const createB = vi
    .spyOn(h.sessionB, "createChannel")
    .mockImplementationOnce(async (_, __, available) => {
      available?.(localB as unknown as RTCDataChannel);
      return localB as unknown as RTCDataChannel;
    });
  await Promise.all([
    h.trustA.requestPairing("b"),
    h.trustB.requestPairing("a"),
  ]);
  const idA = h.trustA.pairing("b")!.id,
    idB = h.trustB.pairing("a")!.id;
  h.eventsA.dispatchEvent(
    "channel",
    remoteA as unknown as RTCDataChannel,
  );
  h.eventsB.dispatchEvent(
    "channel",
    remoteB as unknown as RTCDataChannel,
  );
  expect(remoteA.readyState).toBe("closed");
  expect(remoteB.readyState).toBe("closed");
  expect(h.trustA.pairing("b")?.id).toBe(idA);
  expect(h.trustB.pairing("a")?.id).toBe(idB);
  expect(h.trustA.respondPairing("b", idB, true)).toBe(
    false,
  );
  expect(h.trustB.respondPairing("a", idA, true)).toBe(
    false,
  );
  localA.dispatchEvent(new Event("close"));
  localB.dispatchEvent(new Event("close"));
  expect(h.pairedA).not.toHaveBeenCalled();
  expect(h.pairedB).not.toHaveBeenCalled();
  createA.mockRestore();
  createB.mockRestore();
  await repair(h);
  await settled(a, b);
});

it("ignores an extra pairing channel after a successful confirmation without displacing the trusted connection", async () => {
  const { a, b } = await quarantined();
  const h = await connect(a, b);
  await repair(h);
  await settled(a, b);
  const keys = structuredClone(a.keys);
  const extra = new Channel();
  extra.label = extra.protocol = PAIRING_CHANNEL;
  h.eventsA.dispatchEvent(
    "channel",
    extra as unknown as RTCDataChannel,
  );
  expect(extra.readyState).toBe("closed");
  expect(h.trustA.trusted("b")).toBe(true);
  expect(h.trustA.pairing("b")).toBeUndefined();
  expect(a.keys).toEqual(keys);
});
