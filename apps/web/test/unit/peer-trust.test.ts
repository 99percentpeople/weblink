// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PeerTrustService } from "@/libs/application/peer-trust";
import type {
  DeviceIdentityStore,
  DevicePin,
} from "@/libs/infrastructure/identity/device-identity-store";
import type { PeerSession } from "@/libs/domain/session";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { IdentityProof } from "@/libs/domain/device-identity/handshake";
import type { PairingCredentials } from "@/libs/domain/device-identity/credentials";
import type { PairingRequest } from "@/libs/domain/device-identity/manual-pairing";
const manualHooks = vi.hoisted(
  () =>
    [] as {
      changed(request: PairingRequest): void;
      accepting(): void;
      commit(fingerprint: string): Promise<void>;
      paired(fingerprint: string): void;
    }[],
);
vi.mock(
  "@/libs/domain/device-identity/manual-pairing",
  async (original) => ({
    ...(await original<object>()),
    ManualPairing: class {
      constructor(
        _channel: unknown,
        options: (typeof manualHooks)[number],
      ) {
        manualHooks.push(options);
      }
      close() {}
    },
  }),
);
const hooks = vi.hoisted(
  () =>
    [] as {
      verified(p: IdentityProof): void;
      failed(): void;
      interrupted(): void;
    }[],
);
vi.mock("@/libs/domain/device-identity/handshake", () => ({
  DeviceHandshake: class {
    constructor(
      private readonly channel: RTCDataChannel,
      options: (typeof hooks)[number],
    ) {
      hooks.push(options);
    }
    close() {
      this.channel.close();
    }
    async trust() {}
  },
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  hooks.length = 0;
  manualHooks.length = 0;
  vi.useRealTimers();
});

it("ignores stale automatic verification/failure after an explicit manual approval", async () => {
  const h = setup({
    fingerprint: "old-key",
    blocked: true,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  h.events.dispatchEvent("channel", {
    label: "weblink-device-pairing/1",
    protocol: "weblink-device-pairing/1",
    close() {},
  });
  const manual = manualHooks[0];
  manual.changed({ id: "local-action", state: "incoming" });
  manual.accepting();
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((r) => {
        release = r;
      });
      h.pins.set(id, value);
    },
  );
  const committed = manual.commit("confirmed-key");
  await vi.waitFor(() => expect(release).toBeDefined());
  hooks[0].failed();
  hooks[0].verified(proof);
  hooks[0].interrupted();
  release();
  await committed;
  manual.paired("confirmed-key");
  expect(h.service.trusted("b")).toBe(true);
  expect(h.pins.get("b")).toEqual({
    fingerprint: "confirmed-key",
    blocked: false,
  });
  expect(h.reset).not.toHaveBeenCalled();
  expect(h.paired).toHaveBeenCalledOnce();
});

it("does not apply a manual commit queued for a disconnected binding to its replacement", async () => {
  const h = setup({
    fingerprint: "old-key",
    blocked: true,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  h.events.dispatchEvent("channel", {
    label: "weblink-device-pairing/1",
    protocol: "weblink-device-pairing/1",
    close() {},
  });
  const manual = manualHooks[0];
  manual.accepting();
  h.events.dispatchEvent(
    "peerconnectioninit",
    h.session.peerConnection,
  );
  await expect(manual.commit("stale-key")).rejects.toThrow(
    "PAIRING_CONNECTION_CHANGED",
  );
  manual.paired("stale-key");
  expect(h.service.trusted("b")).toBe(false);
  expect(h.pins.get("b")?.fingerprint).toBe("old-key");
  expect(h.store.pair).not.toHaveBeenCalled();
  expect(h.paired).not.toHaveBeenCalled();
});
function setup(pin?: DevicePin) {
  const pins = new Map<string, DevicePin>();
  if (pin) pins.set("b", pin);
  const reset = vi.fn();
  const paired = vi.fn();
  const store: DeviceIdentityStore = {
    identity: async () => ({
      publicKey: "",
      sign: async () => "",
    }),
    pin: async (id) => pins.get(id),
    save: vi.fn(async (id, value) => {
      pins.set(id, value);
    }),
    pair: vi.fn(async (id, value) => {
      pins.set(id, value);
    }),
  };
  const service = new PeerTrustService(
    { quarantine: reset, paired },
    store,
  );
  const events = new MultiEventEmitter<any>();
  const sdp = `a=fingerprint:sha-256 ${Array(32).fill("ab").join(":")}`;
  const session = {
    clientId: "a",
    targetClientId: "b",
    isMessageChannelReady: true,
    peerConnection: {
      localDescription: { sdp },
      remoteDescription: { sdp },
    },
    addEventListener: events.addEventListener.bind(events),
    createChannel: async (
      _label: string,
      _protocol: string,
      available?: (channel: RTCDataChannel) => void,
    ) => {
      const channel = { close() {} } as RTCDataChannel;
      available?.(channel);
      return channel;
    },
  } as unknown as PeerSession;
  const close = service.bind(session);
  cleanup.push(close);
  return {
    service,
    store,
    reset,
    paired,
    pins,
    events,
    session,
    close,
  };
}
const proof = {
  fingerprint: "new-key",
  remotePairingKnown: false,
};
it("automatically pairs a new device only after verification and durable storage", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  expect(h.service.trusted("b")).toBe(false);
  expect(h.paired).not.toHaveBeenCalled();
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  hooks[0].verified(proof);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(h.service.trusted("b")).toBe(false);
  expect(h.paired).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  await expect(
    h.service.requestPairing("b"),
  ).rejects.toThrow("PAIRING_NOT_READY");
  expect(h.pins.get("b")).toEqual({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  expect(h.store.pair).toHaveBeenCalledOnce();
  expect(h.paired).toHaveBeenCalledOnce();
  expect(h.paired).toHaveBeenCalledWith("b");
  expect(h.reset).not.toHaveBeenCalled();
});
it("quarantines a mismatching key persistently; even the old key needs re-pairing", async () => {
  const h = setup({
    fingerprint: "old-key",
    blocked: false,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.pins.get("b")?.blocked).toBe(true),
  );
  expect(h.service.get("b")?.state).toBe("untrusted");
  h.events.dispatchEvent("messagechannelchange", "closed");
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified({ ...proof, fingerprint: "old-key" });
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("untrusted"),
  );
  expect(h.service.trusted("b")).toBe(false);
  expect(h.paired).not.toHaveBeenCalled();
  expect(h.store.pair).not.toHaveBeenCalled();
});
it("retains permissions for the remembered valid key and ignores a duplicate binding", async () => {
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  expect(h.reset).not.toHaveBeenCalled();
  expect(h.paired).not.toHaveBeenCalled();
  expect(() => h.service.bind(h.session)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  expect(h.service.trusted("b")).toBe(true);
});
it("cannot restore trust from an old verification or pairing completion", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  hooks[0].verified(proof);
  await vi.waitFor(() => expect(release).toBeDefined());
  hooks[0].failed();
  hooks[0].verified(proof);
  release();
  await vi.waitFor(() =>
    expect(h.paired).toHaveBeenCalledOnce(),
  );
  await vi.waitFor(() =>
    expect(h.pins.get("b")?.blocked).toBe(true),
  );
  expect(h.service.get("b")?.state).toBe("untrusted");
  expect(
    h.reset.mock.invocationCallOrder.at(-1),
  ).toBeGreaterThan(h.paired.mock.invocationCallOrder[0]);
});

it("withdraws live authority on authenticated transport loss without quarantining the remembered key", async () => {
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  hooks[0].interrupted();
  expect(h.service.trusted("b")).toBe(false);
  expect(h.pins.get("b")?.blocked).toBe(false);
  expect(h.reset).not.toHaveBeenCalled();
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
});
it("automatically retries an interrupted initial verification, preserving policy and ignoring its stale proof", async () => {
  vi.useFakeTimers();
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  hooks[0].interrupted();
  hooks[0].verified(proof);
  await vi.advanceTimersByTimeAsync(999);
  expect(hooks).toHaveLength(1);
  expect(h.service.get("b")?.state).toBe("verifying");
  expect(h.pins.get("b")?.blocked).toBe(false);
  expect(h.reset).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks).toHaveLength(2);
  hooks[1].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(true);
  expect(h.reset).not.toHaveBeenCalled();
});
it("retries a stalled channel creation without clearing saved permissions", async () => {
  vi.useFakeTimers();
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  vi.spyOn(
    h.session,
    "createChannel",
  ).mockImplementationOnce(() => new Promise(() => {}));
  hooks[0].interrupted();
  await vi.advanceTimersByTimeAsync(13000);
  expect(h.service.get("b")?.state).toBe("verifying");
  expect(h.pins.get("b")?.blocked).toBe(false);
  expect(h.reset).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(hooks).toHaveLength(2);
  hooks[1].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(true);
});
it("owns and closes a connecting identity channel before retrying verification", async () => {
  vi.useFakeTimers();
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  await vi.advanceTimersByTimeAsync(0);
  const channel = {
    readyState: "connecting",
    close: vi.fn(),
  } as unknown as RTCDataChannel;
  const create = vi
    .spyOn(h.session, "createChannel")
    .mockImplementationOnce(
      (_label, _protocol, available) => {
        available?.(channel);
        return new Promise(() => {});
      },
    );
  hooks[0].interrupted();
  await vi.advanceTimersByTimeAsync(1000);
  // The handshake deadline must own this channel even though open never fires.
  expect(hooks).toHaveLength(2);
  hooks[1].interrupted();
  expect(channel.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(create).toHaveBeenCalledTimes(2);
  expect(hooks).toHaveLength(3);
  hooks[1].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(false);
  hooks[2].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(true);
  expect(h.reset).not.toHaveBeenCalled();
  expect(h.pins.get("b")?.blocked).toBe(false);
});
it("retains a valid pairing decision when transport closes during its storage commit", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  hooks[0].verified(proof);
  await vi.waitFor(() => expect(release).toBeDefined());
  hooks[0].interrupted();
  release();
  await vi.waitFor(() =>
    expect(h.paired).toHaveBeenCalledOnce(),
  );
  expect(h.pins.get("b")?.blocked).toBe(false);
  expect(h.paired).toHaveBeenCalledOnce();
  expect(h.service.trusted("b")).toBe(false);
  h.reset.mockClear();
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  expect(h.reset).not.toHaveBeenCalled();
  expect(h.paired).toHaveBeenCalledOnce();
});

it("keeps a new device gated when its initial pin cannot be stored and retries automatically", async () => {
  vi.useFakeTimers();
  const h = setup();
  vi.mocked(h.store.pair).mockRejectedValueOnce(
    new Error("Storage unavailable"),
  );
  await vi.advanceTimersByTimeAsync(0);
  hooks[0].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.get("b")?.state).toBe("verifying");
  expect(h.pins.size).toBe(0);
  expect(h.paired).not.toHaveBeenCalled();
  expect(h.reset).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  hooks[1].verified(proof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(true);
  expect(h.paired).toHaveBeenCalledOnce();
});

it("does not let a duplicate or stale first-use proof replace the live device", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  expect(() => h.service.bind(h.session)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  hooks[0].interrupted();
  hooks[0].verified({ ...proof, fingerprint: "stale-key" });
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  expect(h.pins.get("b")?.fingerprint).toBe(
    proof.fingerprint,
  );
  expect(h.store.pair).toHaveBeenCalledOnce();
  expect(h.paired).toHaveBeenCalledOnce();
});

it.each([
  "issued",
  "pending",
  "received",
  "blocked",
] as const)(
  "requires manual repair when only a remembered %s record survives without a pin",
  async (kind) => {
    const h = setup();
    let keys: PairingCredentials =
      kind === "blocked"
        ? { blocked: true }
        : {
            [kind]: {
              id: "remembered",
              secret: "",
              expiresAt: 1,
            },
          };
    h.store.credentials = () => ({
      read: async () => keys,
      update: async (change) => (keys = change(keys)),
    });
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    hooks[0].verified({ ...proof, credentialIds: [] });
    await vi.waitFor(() =>
      expect(h.service.get("b")?.state).toBe("untrusted"),
    );
    expect(h.store.pair).not.toHaveBeenCalled();
    expect(h.paired).not.toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalledOnce();
    expect(keys.blocked).toBe(true);
  },
);

it("remembers a rejected first connection so it cannot retry as a new device", async () => {
  const h = setup();
  let keys: PairingCredentials = {};
  h.store.credentials = () => ({
    read: async () => keys,
    update: async (change) => (keys = change(keys)),
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].failed();
  await vi.waitFor(() => expect(keys.blocked).toBe(true));
  h.events.dispatchEvent("messagechannelchange", "closed");
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("untrusted"),
  );
  expect(h.pins.size).toBe(0);
  expect(h.store.pair).not.toHaveBeenCalled();
  expect(h.paired).not.toHaveBeenCalled();
});

it.each(["interrupted", "failed"] as const)(
  "orders a first-pairing commit against a concurrent %s callback",
  async (event) => {
    const h = setup();
    let release!: () => void;
    vi.mocked(h.store.pair).mockImplementationOnce(
      async (id, value) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        h.pins.set(id, value);
      },
    );
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    hooks[0].verified(proof);
    await vi.waitFor(() => expect(release).toBeDefined());
    hooks[0][event]();
    release();
    await vi.waitFor(() =>
      expect(h.paired).toHaveBeenCalledOnce(),
    );
    expect(h.service.trusted("b")).toBe(false);
    if (event === "failed") {
      await vi.waitFor(() =>
        expect(h.pins.get("b")?.blocked).toBe(true),
      );
      expect(
        h.reset.mock.invocationCallOrder.at(-1),
      ).toBeGreaterThan(
        h.paired.mock.invocationCallOrder[0],
      );
    } else {
      expect(h.pins.get("b")?.blocked).toBe(false);
      expect(h.reset).not.toHaveBeenCalled();
      h.events.dispatchEvent(
        "messagechannelchange",
        "ready",
      );
      await vi.waitFor(() => expect(hooks).toHaveLength(2));
      hooks[1].verified(proof);
      await vi.waitFor(() =>
        expect(h.service.trusted("b")).toBe(true),
      );
      expect(h.paired).toHaveBeenCalledOnce();
    }
  },
);

const recoveredProof: IdentityProof = {
  ...proof,
  credentialIds: [],
  remotePairingKnown: true,
  recovery: { identityBound: true },
};
it("persists a recovered pin before authority and rejects a duplicate device binding", async () => {
  const h = setup();
  let release!: () => void;
  vi.mocked(h.store.save).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(recoveredProof);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(h.service.trusted("b")).toBe(false);
  expect(() => h.service.bind(h.session)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  release();
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  expect(h.pins.get("b")?.credentialRequired).toBe(true);
  expect(() => h.service.bind(h.session)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  expect(h.service.trusted("b")).toBe(true);
  expect(h.store.pair).not.toHaveBeenCalled();
  expect(h.paired).not.toHaveBeenCalled();
  expect(h.reset).not.toHaveBeenCalled();
});

it.each(["interrupted", "failed"] as const)(
  "does not activate a stale recovered identity when %s races its storage commit",
  async (event) => {
    const h = setup();
    let release!: () => void;
    vi.mocked(h.store.save).mockImplementationOnce(
      async (id, value) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        h.pins.set(id, value);
      },
    );
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    hooks[0].verified(recoveredProof);
    await vi.waitFor(() => expect(release).toBeDefined());
    hooks[0][event]();
    hooks[0].verified(recoveredProof);
    release();
    await vi.waitFor(() =>
      expect(h.pins.has("b")).toBe(true),
    );
    expect(h.service.trusted("b")).toBe(false);
    expect(h.paired).not.toHaveBeenCalled();
    if (event === "failed") {
      await vi.waitFor(() =>
        expect(h.pins.get("b")?.blocked).toBe(true),
      );
      expect(h.reset).toHaveBeenCalledOnce();
    } else {
      expect(h.reset).not.toHaveBeenCalled();
      h.events.dispatchEvent(
        "messagechannelchange",
        "ready",
      );
      await vi.waitFor(() => expect(hooks).toHaveLength(2));
      hooks[1].verified(recoveredProof);
      await vi.waitFor(() =>
        expect(h.service.trusted("b")).toBe(true),
      );
      expect(h.reset).not.toHaveBeenCalled();
    }
  },
);

it("retries a failed recovery pin write without granting authority or clearing policy", async () => {
  vi.useFakeTimers();
  const h = setup();
  vi.mocked(h.store.save).mockRejectedValueOnce(
    new Error("Storage unavailable"),
  );
  await vi.advanceTimersByTimeAsync(0);
  hooks[0].verified(recoveredProof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.get("b")?.state).toBe("verifying");
  expect(h.pins.size).toBe(0);
  expect(h.reset).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  hooks[1].verified(recoveredProof);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.service.trusted("b")).toBe(true);
  expect(h.paired).not.toHaveBeenCalled();
});

it("cannot use a historical binding to replace a different current identity pin", async () => {
  const h = setup({
    fingerprint: "current-identity",
    blocked: false,
    credentialRequired: true,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(recoveredProof);
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("untrusted"),
  );
  expect(h.pins.get("b")?.fingerprint).toBe(
    "current-identity",
  );
  expect(h.paired).not.toHaveBeenCalled();
});

it("does not fall back to a required public pin without negotiated recovery", async () => {
  const h = setup({
    fingerprint: proof.fingerprint,
    blocked: false,
    credentialRequired: true,
  });
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified({
    ...proof,
    credentialIds: [],
    remotePairingKnown: true,
  });
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("untrusted"),
  );
  expect(h.paired).not.toHaveBeenCalled();
});
