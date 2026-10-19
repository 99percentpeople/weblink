// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { webcrypto } from "node:crypto";
import {
  deviceIdentity,
  fingerprint,
  transportFingerprint,
  type DeviceIdentity,
} from "@/libs/domain/device-identity/crypto";
import {
  DeviceHandshake,
  type IdentityProof,
} from "@/libs/domain/device-identity/handshake";

class Channel extends EventTarget {
  readyState = "open";
  other?: Channel;
  frames: string[] = [];
  transform = (raw: string) => raw;
  send(raw: string) {
    this.frames.push(raw);
    queueMicrotask(() =>
      this.other?.dispatchEvent(
        new MessageEvent("message", {
          data: this.transform(raw),
        }),
      ),
    );
  }
  close() {
    this.readyState = "closed";
  }
}
const cleanup: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const identity = async () =>
  deviceIdentity(
    await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  );
function connect(
  a: DeviceIdentity,
  b: DeviceIdentity,
  transform?: (raw: string) => string,
  remoteTransport = "b-cert",
) {
  const left = new Channel(),
    right = new Channel();
  left.other = right;
  right.other = left;
  if (transform) right.transform = transform;
  const verifiedA = vi.fn<(proof: IdentityProof) => void>(),
    verifiedB = vi.fn(),
    failedA = vi.fn(),
    failedB = vi.fn();
  const interruptedA = vi.fn(),
    interruptedB = vi.fn();
  const ha = new DeviceHandshake(
    left as unknown as RTCDataChannel,
    {
      client: "a",
      target: "b",
      localTransport: "a-cert",
      remoteTransport,
      identity: Promise.resolve(a),
      verified: verifiedA,
      failed: failedA,
      interrupted: interruptedA,
    },
  );
  const hb = new DeviceHandshake(
    right as unknown as RTCDataChannel,
    {
      client: "b",
      target: "a",
      localTransport: "b-cert",
      remoteTransport: "a-cert",
      identity: Promise.resolve(b),
      verified: verifiedB,
      failed: failedB,
      interrupted: interruptedB,
    },
  );
  cleanup.push(() => {
    ha.close();
    hb.close();
  });
  return {
    left,
    right,
    verifiedA,
    verifiedB,
    failedA,
    failedB,
    interruptedA,
    interruptedB,
  };
}
it.each(["close", "error"])(
  "withdraws verification on channel %s without declaring the saved identity invalid",
  async (event) => {
    const h = connect(await identity(), await identity());
    h.left.dispatchEvent(new Event(event));
    await Promise.resolve();
    expect(h.failedA).not.toHaveBeenCalled();
    expect(h.verifiedA).not.toHaveBeenCalled();
    expect(h.interruptedA).toHaveBeenCalledOnce();
  },
);
it("treats a missing handshake response as an interruption rather than a wrong key", async () => {
  const local = await identity();
  vi.useFakeTimers();
  const channel = new Channel(),
    failed = vi.fn(),
    interrupted = vi.fn(),
    verified = vi.fn();
  const h = new DeviceHandshake(
    channel as unknown as RTCDataChannel,
    {
      client: "a",
      target: "b",
      localTransport: "a-cert",
      remoteTransport: "b-cert",
      identity: Promise.resolve(local),
      verified,
      failed,
      interrupted,
    },
  );
  cleanup.push(() => h.close());
  await vi.advanceTimersByTimeAsync(10000);
  expect(interrupted).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
  expect(verified).not.toHaveBeenCalled();
  vi.useRealTimers();
});
it("proves both device keys and displays the same fresh pairing code", async () => {
  const a = await identity(),
    b = await identity();
  const h = connect(a, b);
  await vi.waitFor(() =>
    expect(h.verifiedA).toHaveBeenCalledOnce(),
  );
  await vi.waitFor(() =>
    expect(h.verifiedB).toHaveBeenCalledOnce(),
  );
  expect(h.verifiedA.mock.calls[0][0].fingerprint).toBe(
    await fingerprint(b.publicKey),
  );
  expect(h.verifiedA.mock.calls[0][0].code).toBe(
    h.verifiedB.mock.calls[0][0].code,
  );
  const again = connect(a, b);
  await vi.waitFor(() =>
    expect(again.verifiedA).toHaveBeenCalledOnce(),
  );
  expect(again.verifiedA.mock.calls[0][0].code).not.toBe(
    h.verifiedA.mock.calls[0][0].code,
  );
});
it("rejects a replayed proof and leaves the new connection unauthenticated", async () => {
  const a = await identity(),
    b = await identity();
  const first = connect(a, b);
  await vi.waitFor(() =>
    expect(first.verifiedA).toHaveBeenCalledOnce(),
  );
  const proof = first.right.frames.find(
    (raw) => JSON.parse(raw).kind === "proof",
  )!;
  const replay = connect(a, b, (raw) =>
    JSON.parse(raw).kind === "proof" ? proof : raw,
  );
  await vi.waitFor(() =>
    expect(replay.failedA).toHaveBeenCalledOnce(),
  );
  expect(replay.verifiedA).not.toHaveBeenCalled();
});
it("rejects relaying a valid device handshake across a different DTLS connection", async () => {
  const h = connect(
    await identity(),
    await identity(),
    undefined,
    "attacker-cert",
  );
  await vi.waitFor(() =>
    expect(h.failedA).toHaveBeenCalledOnce(),
  );
  expect(h.verifiedA).not.toHaveBeenCalled();
});
it("rejects a substituted public key and malformed or duplicate identity frames", async () => {
  const substitute = await identity();
  const h = connect(
    await identity(),
    await identity(),
    (raw) => {
      const frame = JSON.parse(raw);
      return JSON.stringify(
        frame.kind === "hello"
          ? { ...frame, key: substitute.publicKey }
          : frame,
      );
    },
  );
  await vi.waitFor(() =>
    expect(h.failedA).toHaveBeenCalledOnce(),
  );
  expect(h.verifiedA).not.toHaveBeenCalled();
});
it("requires an SDP SHA256 transport certificate", () => {
  expect(() => transportFingerprint("v=0")).toThrow(
    "IDENTITY_TRANSPORT_UNAVAILABLE",
  );
  const cert = Array(32).fill("AB").join(":");
  expect(
    transportFingerprint(
      `v=0\r\na=fingerprint:sha-256 ${cert}\r\na=fingerprint:sha-256 ${cert}`,
    ),
  ).toBe(cert.toLowerCase());
});

it("waits for the initiator before sending a responder hello, even if the responder channel opens first", async () => {
  const a = await identity(),
    b = await identity();
  const left = new Channel(),
    right = new Channel();
  left.other = right;
  right.other = left;
  const verifiedA = vi.fn(),
    verifiedB = vi.fn(),
    failed = vi.fn();
  const responder = new DeviceHandshake(
    right as unknown as RTCDataChannel,
    {
      client: "b",
      target: "a",
      localTransport: "b-cert",
      remoteTransport: "a-cert",
      identity: Promise.resolve(b),
      verified: verifiedB,
      failed,
    },
  );
  cleanup.push(() => responder.close());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(right.frames).toEqual([]);
  const initiator = new DeviceHandshake(
    left as unknown as RTCDataChannel,
    {
      client: "a",
      target: "b",
      localTransport: "a-cert",
      remoteTransport: "b-cert",
      identity: Promise.resolve(a),
      verified: verifiedA,
      failed,
    },
  );
  cleanup.push(() => initiator.close());
  await vi.waitFor(() =>
    expect(verifiedA).toHaveBeenCalledOnce(),
  );
  await vi.waitFor(() =>
    expect(verifiedB).toHaveBeenCalledOnce(),
  );
  expect(failed).not.toHaveBeenCalled();
  left.dispatchEvent(new Event("close"));
  expect(failed).not.toHaveBeenCalled();
});
