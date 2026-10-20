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
  ManualPairing,
  PAIRING_CHANNEL,
  PAIRING_TIMEOUT,
  type PairingRequest,
} from "@/libs/domain/device-identity/manual-pairing";
import {
  deviceIdentity,
  fingerprint,
} from "@/libs/domain/device-identity/crypto";
import { applicationChannel } from "@/libs/domain/device-identity/access";

class Channel extends EventTarget {
  readyState = "open";
  other!: Channel;
  frames: Record<string, unknown>[] = [];
  filter = (frame: Record<string, unknown>) => frame;
  send(raw: string) {
    if (this.readyState !== "open")
      throw new Error("Closed");
    const frame = this.filter(JSON.parse(raw));
    this.frames.push(frame);
    queueMicrotask(() => {
      if (this.other.readyState === "open")
        this.other.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify(frame),
          }),
        );
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    queueMicrotask(() => {
      this.other.readyState = "closed";
      this.other.dispatchEvent(new Event("close"));
    });
  }
}
const cleanup: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  cleanup.splice(0).forEach((f) => f());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const identity = async () => {
  const result = await deviceIdentity(
    await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    ),
  );
  return { ...result, sign: vi.fn(result.sign) };
};
async function connect(
  filter?: Channel["filter"],
  outgoingId?: string,
) {
  const a = await identity(),
    b = await identity();
  const left = new Channel(),
    right = new Channel();
  left.other = right;
  right.other = left;
  if (filter) left.filter = filter;
  const endpoint = (client: string, key: typeof a) => ({
    client,
    target: client === "a" ? "b" : "a",
    localTransport: `${client}-dtls`,
    remoteTransport: client === "a" ? "b-dtls" : "a-dtls",
    identity: Promise.resolve(key),
    changed: vi.fn<(request: PairingRequest) => void>(),
    accepting: vi.fn(),
    commit: vi.fn(async (_pin: string) => {}),
    paired: vi.fn(),
    ended: vi.fn(),
  });
  const oa = endpoint("a", a),
    ob = endpoint("b", b);
  const id = outgoingId ?? crypto.randomUUID();
  const receiver = new ManualPairing(
    right as unknown as RTCDataChannel,
    ob,
  );
  const sender = new ManualPairing(
    left as unknown as RTCDataChannel,
    { ...oa, outgoing: id },
  );
  cleanup.push(() => {
    sender.close();
    receiver.close();
  });
  return {
    a,
    b,
    oa,
    ob,
    sender,
    receiver,
    left,
    right,
    id,
    get approvalId() {
      return (
        ob.changed.mock.calls.find(
          ([r]) => r.state === "incoming",
        )?.[0].id ?? ""
      );
    },
  };
}
type Harness = Awaited<ReturnType<typeof connect>>;
async function incoming(h: Harness) {
  await vi.waitFor(() =>
    expect(h.ob.changed).toHaveBeenLastCalledWith({
      id: h.approvalId,
      state: "incoming",
    }),
  );
}

it("requires one request and the other device's explicit approval, without identity proof or a code", async () => {
  const h = await connect();
  await incoming(h);
  expect(h.oa.commit).not.toHaveBeenCalled();
  expect(h.ob.commit).not.toHaveBeenCalled();
  expect(h.oa.paired).not.toHaveBeenCalled();
  expect(h.ob.paired).not.toHaveBeenCalled();
  expect(h.a.sign).not.toHaveBeenCalled();
  expect(h.b.sign).not.toHaveBeenCalled();
  expect(h.left.frames.map((f) => f.kind)).toEqual([
    "request",
  ]);
  expect(h.receiver.respond(h.approvalId, true)).toBe(true);
  expect(h.receiver.respond(h.approvalId, true)).toBe(
    false,
  );
  await vi.waitFor(() => {
    expect(h.oa.paired).toHaveBeenCalledOnce();
    expect(h.ob.paired).toHaveBeenCalledOnce();
  });
  expect(h.oa.commit).toHaveBeenCalledWith(
    await fingerprint(h.b.publicKey),
  );
  expect(h.ob.commit).toHaveBeenCalledWith(
    await fingerprint(h.a.publicKey),
  );
  expect(h.a.sign).not.toHaveBeenCalled();
  expect(h.b.sign).not.toHaveBeenCalled();
  expect(
    h.left.frames.some(
      (f) => "code" in f || f.kind === "proof",
    ),
  ).toBe(false);
});

it("does not grant authority until both storage commits have completed", async () => {
  const h = await connect();
  await incoming(h);
  let release!: () => void;
  h.oa.commit.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  h.receiver.respond(h.approvalId, true);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(h.ob.commit).toHaveBeenCalledOnce();
  expect(h.oa.paired).not.toHaveBeenCalled();
  expect(h.ob.paired).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => {
    expect(h.oa.paired).toHaveBeenCalledOnce();
    expect(h.ob.paired).toHaveBeenCalledOnce();
  });
});

it.each([
  "reject",
  "cancel",
  "timeout",
  "disconnect",
] as const)(
  "ends a pending request on %s without changing trust or saved permissions",
  async (action) => {
    const h = await connect();
    await incoming(h);
    if (action === "reject")
      h.receiver.respond(h.approvalId, false);
    if (action === "cancel") h.sender.cancel(h.id);
    if (action === "disconnect") h.left.close();
    if (action === "timeout") {
      // Timers were installed with real clocks; capture a fresh request under
      // the fake clock while keeping WebCrypto completion asynchronous.
      h.sender.close();
      h.receiver.close();
      vi.useFakeTimers();
      const timed = await connect();
      await vi.waitFor(() =>
        expect(timed.ob.changed).toHaveBeenCalled(),
      );
      await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT);
      expect(timed.ob.ended).toHaveBeenCalledWith(
        "timeout",
        false,
      );
      expect(timed.oa.ended).toHaveBeenCalled();
      expect(
        timed.receiver.respond(timed.approvalId, true),
      ).toBe(false);
      expect(timed.oa.commit).not.toHaveBeenCalled();
      expect(timed.ob.commit).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(h.oa.ended).toHaveBeenCalled(),
      );
    }
    expect(h.receiver.respond(h.approvalId, true)).toBe(
      false,
    );
    expect(h.oa.commit).not.toHaveBeenCalled();
    expect(h.ob.commit).not.toHaveBeenCalled();
    expect(h.oa.paired).not.toHaveBeenCalled();
    expect(h.ob.paired).not.toHaveBeenCalled();
  },
);

it.each(["client", "target", "transport", "key"] as const)(
  "rejects a request with an invalid %s before showing an approval",
  async (field) => {
    const h = await connect((frame) => ({
      ...frame,
      [field]: "different",
    }));
    await vi.waitFor(() =>
      expect(h.ob.ended).toHaveBeenCalledWith(
        "invalid",
        false,
      ),
    );
    expect(h.ob.changed).not.toHaveBeenCalled();
    expect(h.ob.commit).not.toHaveBeenCalled();
  },
);

it.each([
  "committed",
  "credential-ready",
  "credential-offer",
  "accept",
])(
  "rejects %s before approval and cannot bypass confirmation",
  async (kind) => {
    const h = await connect();
    await incoming(h);
    h.left.send(JSON.stringify({ kind, request: h.id }));
    await vi.waitFor(() =>
      expect(h.ob.ended).toHaveBeenCalledWith(
        "invalid",
        false,
      ),
    );
    expect(h.oa.commit).not.toHaveBeenCalled();
    expect(h.ob.commit).not.toHaveBeenCalled();
    expect(h.ob.paired).not.toHaveBeenCalled();
  },
);

it.each(["a", "b"])(
  "keeps both ends gated when %s cannot save the decision",
  async (side) => {
    const h = await connect();
    await incoming(h);
    (side === "a"
      ? h.oa
      : h.ob
    ).commit.mockRejectedValueOnce(new Error("Disk full"));
    h.receiver.respond(h.approvalId, true);
    await vi.waitFor(() => {
      expect(h.oa.ended).toHaveBeenCalled();
      expect(h.ob.ended).toHaveBeenCalled();
    });
    expect(h.oa.paired).not.toHaveBeenCalled();
    expect(h.ob.paired).not.toHaveBeenCalled();
  },
);

it("rejects stale request IDs and does not activate a storage completion after disconnect", async () => {
  const h = await connect();
  await incoming(h);
  expect(
    h.receiver.respond(crypto.randomUUID(), true),
  ).toBe(false);
  let release!: () => void;
  h.ob.commit.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  h.receiver.respond(h.approvalId, true);
  await vi.waitFor(() => expect(release).toBeDefined());
  h.right.close();
  release();
  await vi.waitFor(() =>
    expect(h.oa.ended).toHaveBeenCalled(),
  );
  expect(h.oa.paired).not.toHaveBeenCalled();
  expect(h.ob.paired).not.toHaveBeenCalled();
  expect(h.receiver.respond(h.approvalId, true)).toBe(
    false,
  );
});

it("allows only the exact pairing bootstrap channel through the permission gate", () => {
  expect(
    applicationChannel(PAIRING_CHANNEL, PAIRING_CHANNEL),
  ).toBe(false);
  expect(applicationChannel(PAIRING_CHANNEL, "file")).toBe(
    true,
  );
  expect(applicationChannel("file", PAIRING_CHANNEL)).toBe(
    true,
  );
});

it("rejects an expired approval even when a suspended page has not run its timer", async () => {
  const h = await connect();
  await incoming(h);
  vi.spyOn(Date, "now").mockReturnValue(
    Date.now() + PAIRING_TIMEOUT + 1,
  );
  expect(h.receiver.respond(h.approvalId, true)).toBe(
    false,
  );
  expect(h.ob.ended).toHaveBeenCalledWith("timeout", false);
  expect(h.ob.commit).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("a timeout during storage never sends a late confirmation or grants authority", async () => {
  vi.useFakeTimers();
  const h = await connect();
  await incoming(h);
  let release!: () => void;
  h.ob.commit.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  h.receiver.respond(h.approvalId, true);
  await vi.waitFor(() => expect(release).toBeDefined());
  await vi.advanceTimersByTimeAsync(PAIRING_TIMEOUT);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.ob.paired).not.toHaveBeenCalled();
  expect(h.oa.paired).not.toHaveBeenCalled();
  expect(
    h.right.frames.some((f) => f.kind === "committed"),
  ).toBe(false);
});

it("replaying a remote request ID on a new connection cannot revive an old approval action", async () => {
  const first = await connect();
  await incoming(first);
  const stale = first.approvalId;
  first.sender.close();
  first.receiver.close();
  const next = await connect(undefined, first.id);
  await incoming(next);
  expect(next.id).toBe(first.id);
  expect(next.approvalId).not.toBe(stale);
  expect(next.receiver.respond(stale, true)).toBe(false);
  expect(next.ob.commit).not.toHaveBeenCalled();
  expect(next.oa.commit).not.toHaveBeenCalled();
});
