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
      _channel: unknown,
      options: (typeof hooks)[number],
    ) {
      hooks.push(options);
    }
    close() {}
    async trust() {}
  },
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  hooks.length = 0;
  vi.useRealTimers();
});
function setup(pin?: DevicePin) {
  const pins = new Map<string, DevicePin>();
  if (pin) pins.set("b", pin);
  const reset = vi.fn();
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
  const service = new PeerTrustService(reset, store);
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
    createChannel: async () => ({ close() {} }),
  } as unknown as PeerSession;
  const close = service.bind(session);
  cleanup.push(close);
  return {
    service,
    store,
    reset,
    pins,
    events,
    session,
    close,
  };
}
const proof = {
  fingerprint: "new-key",
  code: "1234567890abcdef",
};
it("keeps a new device paired only after explicit confirmation and resets every permission", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("unpaired"),
  );
  expect(h.service.trusted("b")).toBe(false);
  await expect(
    h.service.pair("b", proof.fingerprint, "stale-code"),
  ).rejects.toThrow("PAIRING_NOT_READY");
  await h.service.pair("b", proof.fingerprint, proof.code);
  expect(h.service.trusted("b")).toBe(true);
  expect(h.pins.get("b")).toEqual({
    fingerprint: proof.fingerprint,
    blocked: false,
  });
  expect(h.reset).toHaveBeenCalledTimes(2);
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
  expect(() => h.service.bind(h.session)).toThrow(
    "DUPLICATE_DEVICE_ID",
  );
  expect(h.service.trusted("b")).toBe(true);
});
it("cannot restore trust from an old verification or pairing completion", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("unpaired"),
  );
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  const pairing = h.service.pair(
    "b",
    proof.fingerprint,
    proof.code,
  );
  const rejected = expect(pairing).rejects.toThrow(
    "PAIRING_CONNECTION_CHANGED",
  );
  await vi.waitFor(() => expect(release).toBeDefined());
  hooks[0].failed();
  hooks[0].verified(proof);
  release();
  await rejected;
  await vi.waitFor(() =>
    expect(h.pins.get("b")?.blocked).toBe(true),
  );
  expect(h.service.get("b")?.state).toBe("untrusted");
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
it("retains a valid pairing decision when transport closes during its storage commit", async () => {
  const h = setup();
  await vi.waitFor(() => expect(hooks).toHaveLength(1));
  hooks[0].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.get("b")?.state).toBe("unpaired"),
  );
  let release!: () => void;
  vi.mocked(h.store.pair).mockImplementationOnce(
    async (id, value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      h.pins.set(id, value);
    },
  );
  const pairing = h.service.pair(
    "b",
    proof.fingerprint,
    proof.code,
  );
  const rejected = expect(pairing).rejects.toThrow(
    "PAIRING_CONNECTION_CHANGED",
  );
  await vi.waitFor(() => expect(release).toBeDefined());
  hooks[0].interrupted();
  release();
  await rejected;
  expect(h.pins.get("b")?.blocked).toBe(false);
  expect(h.service.trusted("b")).toBe(false);
  h.reset.mockClear();
  h.events.dispatchEvent("messagechannelchange", "ready");
  await vi.waitFor(() => expect(hooks).toHaveLength(2));
  hooks[1].verified(proof);
  await vi.waitFor(() =>
    expect(h.service.trusted("b")).toBe(true),
  );
  expect(h.reset).not.toHaveBeenCalled();
});
