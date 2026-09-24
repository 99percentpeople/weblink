// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  PeerSessionLifecycleController,
  type PeerSessionStatus,
} from "@/libs/domain/session-lifecycle";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type {
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "@/libs/domain/signaling";
import { PEER_SESSION_DISCONNECTED_GRACE_MS } from "@/constants";

const controllers: PeerSessionLifecycleController[] = [];
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function harness(
  connected = false,
  negotiated = true,
  polite = false,
) {
  const events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  let signalStatus: SignalingServiceStatus = "disconnected";
  let status: PeerSessionStatus = connected
    ? "connected"
    : "disconnected";
  let pc = connected
    ? ({
        connectionState: "connected",
        iceConnectionState: "connected",
      } as RTCPeerConnection)
    : null;
  const sender: SignalingService = {
    clientId: "local",
    targetClientId: "remote",
    get status() {
      return signalStatus;
    },
    sendSignal: vi.fn(),
    close: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener:
      events.removeEventListener.bind(events),
  };
  const disconnect = vi.fn(() => {
    pc = null;
    status = "disconnected";
  });
  const reconnect = vi.fn(async () => {
    pc = {
      connectionState: "connected",
      iceConnectionState: "connected",
    } as RTCPeerConnection;
    status = "connected";
  });
  const controller = new PeerSessionLifecycleController({
    sender,
    polite,
    getStatus: () => status,
    setStatus: (value) => {
      status = value;
    },
    getPeerConnection: () => pc,
    disconnect,
    close: () => {
      controller.dispose();
      status = "closed";
    },
    reconnect,
    updateMessageChannelOpenState: vi.fn(),
    isMessageChannelReady: () => true,
    ensureMessageChannelReady: vi.fn(async () => {}),
  });
  controllers.push(controller);
  if (negotiated) controller.markConnectable();
  else controller.markListening();
  return {
    controller,
    reconnect,
    disconnect,
    sender,
    setPeerConnection: (next: RTCPeerConnection) => {
      pc = next;
    },
    setPeerStatus: (next: PeerSessionStatus) => {
      status = next;
    },
    signal(next: Exclude<SignalingServiceStatus, "init">) {
      signalStatus = next;
      events.dispatchEvent("statuschange", next);
    },
    peerOnline: () =>
      events.dispatchEvent("peeravailable", undefined),
  };
}

afterEach(() => {
  controllers
    .splice(0)
    .forEach((controller) => controller.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("event-driven peer recovery", () => {
  it("waits passively for signaling with no PC retries or signaling-wait timers", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.controller.handleDisconnection();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.signal("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnect).toHaveBeenCalledOnce();
    expect(h.reconnect).toHaveBeenCalledWith({
      initiate: true,
    });
  });

  it("uses the negotiation role to choose the automatic offer owner", async () => {
    const polite = harness(false, true, true);
    polite.signal("connected");
    await flush();
    expect(polite.reconnect).toHaveBeenCalledWith({
      initiate: false,
    });

    const impolite = harness();
    impolite.signal("connected");
    await flush();
    expect(impolite.reconnect).toHaveBeenCalledWith({
      initiate: true,
    });
  });

  it("does not poll after a failed attempt; peer-online allows one new attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    h.reconnect.mockRejectedValueOnce(
      new Error("unreachable peer"),
    );
    h.signal("connected");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.peerOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not turn repeated focus or duplicate connected status into retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(false, false);
    h.setPeerStatus("created");
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.reconnect).not.toHaveBeenCalled();
    h.reconnect.mockRejectedValueOnce(
      new Error("unreachable peer"),
    );
    h.signal("connected");
    await flush();
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
      h.signal("connected");
    }
    await flush();
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("preserves a healthy PC across both local and remote socket recovery", async () => {
    const h = harness(true);
    h.signal("connected");
    h.peerOnline();
    await flush();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it("recovers a pure RTC failure once even when signaling never disconnected", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(true);
    h.signal("connected");
    await vi.advanceTimersByTimeAsync(0);
    const failed = {
      connectionState: "failed",
    } as RTCPeerConnection;
    h.setPeerConnection(failed);
    h.reconnect.mockRejectedValueOnce(
      new Error("ICE failed"),
    );
    h.controller.handleConnectionStateChange(failed);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.reconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    // A late state event belongs to the PC discarded by the failed attempt.
    h.controller.handleConnectionStateChange(failed);
    await flush();
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("coalesces fresh availability during an attempt without retrying failures themselves", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    let reject!: (error: Error) => void;
    h.reconnect.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.signal("connected");
    await flush();
    await h.controller.handleDisconnection(
      "duplicate-failure",
    );
    h.peerOnline();
    h.peerOnline();
    expect(h.reconnect).toHaveBeenCalledOnce();
    reject(new Error("retired network attempt"));
    await flush();
    expect(h.reconnect).toHaveBeenCalledTimes(2);
    h.peerOnline();
    await flush();
    expect(h.reconnect).toHaveBeenCalledTimes(2);
  });

  it("preserves a connection recovered during the disconnected grace period", async () => {
    vi.useFakeTimers();
    const h = harness(true);
    h.signal("connected");
    await vi.advanceTimersByTimeAsync(0);
    const pc = {
      connectionState:
        "disconnected" as RTCPeerConnectionState,
    };
    h.setPeerConnection(pc as RTCPeerConnection);
    h.controller.handleConnectionStateChange(
      pc as RTCPeerConnection,
    );
    pc.connectionState = "connected";
    h.controller.handleConnectionStateChange(
      pc as RTCPeerConnection,
    );
    await vi.advanceTimersByTimeAsync(
      PEER_SESSION_DISCONNECTED_GRACE_MS * 2,
    );
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits while frozen and resumes once without a retry loop", async () => {
    const h = harness(true);
    h.signal("connected");
    await flush();
    document.dispatchEvent(new Event("freeze"));
    h.peerOnline();
    await flush();
    expect(h.reconnect).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("resume"));
    document.dispatchEvent(new Event("resume"));
    await flush();
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("does not react to local or remote availability after disposal", async () => {
    const h = harness();
    await h.controller.handleDisconnection();
    h.controller.dispose();
    h.signal("connected");
    h.peerOnline();
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
