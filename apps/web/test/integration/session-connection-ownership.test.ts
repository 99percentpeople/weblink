import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerSession } from "@/libs/domain/session";
import type {
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "@/libs/domain/signaling";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";

async function flush() {
  for (let index = 0; index < 40; index++)
    await Promise.resolve();
}

class PeerConnection extends EventTarget {
  static instances: PeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null =
    null;
  currentRemoteDescription: RTCSessionDescriptionInit | null =
    null;
  getSenders = () => [];
  addTransceiver = vi.fn();
  constructor() {
    super();
    PeerConnection.instances.push(this);
  }
  async setLocalDescription() {
    const answer =
      this.signalingState === "have-remote-offer";
    this.localDescription = {
      type: answer ? "answer" : "offer",
      sdp: "local",
    };
    this.signalingState = answer
      ? "stable"
      : "have-local-offer";
    if (answer)
      this.currentRemoteDescription =
        this.remoteDescription;
  }
  async setRemoteDescription(
    description: RTCSessionDescriptionInit,
  ) {
    this.remoteDescription = description;
    this.signalingState =
      description.type === "offer"
        ? "have-remote-offer"
        : "stable";
    if (description.type === "answer")
      this.currentRemoteDescription = description;
  }
  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  close() {
    this.connectionState = "closed";
    this.signalingState = "closed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
}

async function harness() {
  const events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  let status: SignalingServiceStatus = "connected";
  const sender = {
    clientId: "local",
    targetClientId: "remote",
    get status() {
      return status;
    },
    sendSignal: vi.fn(async () => {}),
    addEventListener: vi.fn(
      events.addEventListener.bind(events),
    ),
    removeEventListener:
      events.removeEventListener.bind(events),
    close: vi.fn(),
  } satisfies SignalingService;
  const session = new PeerSession(sender, { polite: true });
  // Channel behavior is covered by its own tests; this fixture has no SCTP.
  vi.spyOn(
    (session as any).dataChannels,
    "ensureMessageChannelReady",
  ).mockResolvedValue(undefined);
  await session.listen();
  return {
    session,
    sender,
    current: () =>
      session.peerConnection as unknown as PeerConnection,
    subscriptions: () =>
      sender.addEventListener.mock.calls.filter(
        ([event]) => event === "signal",
      ),
    status(next: Exclude<SignalingServiceStatus, "init">) {
      status = next;
      events.dispatchEvent("statuschange", next);
    },
    async offer(generation: string) {
      events.dispatchEvent("signal", {
        clientId: "remote",
        targetClientId: "local",
        type: "offer",
        data: { sdp: "remote", generation },
      });
      await flush();
    },
  };
}

beforeEach(() => {
  PeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.stubGlobal(
    "RTCSessionDescription",
    class {
      type: RTCSdpType;
      sdp: string;
      constructor(description: RTCSessionDescriptionInit) {
        this.type = description.type;
        this.sdp = description.sdp ?? "";
      }
    },
  );
  for (const level of [
    "debug",
    "info",
    "warn",
    "error",
  ] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("session and connection lifetime ownership", () => {
  it("keeps one signaling subscription across repeated listens and local transport replacements", async () => {
    const h = await harness();
    try {
      const first = h.current();
      await h.session.listen();
      expect(h.current()).toBe(first);
      expect(PeerConnection.instances).toHaveLength(1);
      const subscription =
        h.subscriptions()[0][2] as AddEventListenerOptions;
      for (let cycle = 0; cycle < 3; cycle++) {
        const old = h.current();
        const reconnecting = h.session.reconnect({
          initiate: false,
        });
        await flush();
        const current = h.current();
        expect(current).not.toBe(old);
        expect(old.connectionState).toBe("closed");
        current.connect();
        await reconnecting;
        old.dispatchEvent(
          new Event("connectionstatechange"),
        );
        expect(h.current()).toBe(current);
        expect(h.subscriptions()).toHaveLength(1);
        expect(subscription.signal!.aborted).toBe(false);
      }
      h.session.close();
      expect(subscription.signal!.aborted).toBe(true);
    } finally {
      h.session.close();
    }
  });

  it("uses the same replacement entry for remote restarts without replacing the signaling listener", async () => {
    const h = await harness();
    try {
      await h.offer("first");
      h.current().connect();
      const first = h.current();
      await h.offer("second");
      const replacement = h.current();
      expect(replacement).not.toBe(first);
      expect(first.connectionState).toBe("closed");
      expect(replacement.remoteDescription?.sdp).toBe(
        "remote",
      );
      await h.offer("second");
      await h.offer("first");
      expect(h.current()).toBe(replacement);
      expect(PeerConnection.instances).toHaveLength(2);
      expect(h.subscriptions()).toHaveLength(1);
    } finally {
      h.session.close();
    }
  });

  it("cancels a retired signaling wait without discarding the live subscription", async () => {
    const h = await harness();
    try {
      h.status("disconnected");
      const first = h.session.reconnect({
        initiate: false,
      });
      const retired =
        expect(first).rejects.toThrow("aborted");
      await flush();
      const second = h.session.reconnect({
        initiate: false,
      });
      void second.catch(() => {});
      await retired;
      expect(h.subscriptions()).toHaveLength(1);
      // Close while the replacement still waits for signaling. Both pending
      // attempts must settle without requiring a timeout or a future socket.
      h.session.close();
      await expect(second).rejects.toThrow("aborted");
    } finally {
      h.session.close();
    }
  });

  it("clears the connection timeout and listeners when passive recovery is cancelled", async () => {
    vi.useFakeTimers();
    const h = await harness();
    const reconnecting = h.session.reconnect({
      initiate: false,
    });
    const rejected =
      expect(reconnecting).rejects.toThrow("aborted");
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    h.session.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
