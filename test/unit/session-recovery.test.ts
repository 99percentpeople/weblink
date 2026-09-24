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
import { SIGNALING_CONNECTION_TIMEOUT_MS } from "@/constants";

const controllers: PeerSessionLifecycleController[] = [];
function harness(connected = false, negotiated = true) {
  const events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  let signalStatus: SignalingServiceStatus = "disconnected";
  let status: PeerSessionStatus = "disconnected";
  let pc = connected
    ? ({
        connectionState: "connected",
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
  const resetSession = vi.fn(() => {
    pc = null;
  });
  const reconnect = vi.fn(async () => {
    pc = {
      connectionState: "connected",
    } as RTCPeerConnection;
    status = "connected";
  });
  const controller = new PeerSessionLifecycleController({
    sender,
    polite: false,
    clientId: () => "local",
    getStatus: () => status,
    setStatus: (value) => {
      status = value;
    },
    getPeerConnection: () => pc,
    resetSession,
    disconnect: () => {
      pc = null;
      status = "disconnected";
    },
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
    resetSession,
    sender,
    setPeerStatus: (next: PeerSessionStatus) => {
      status = next;
    },
    signal: (
      next: Exclude<SignalingServiceStatus, "init">,
    ) => {
      signalStatus = next;
      events.dispatchEvent("statuschange", next);
    },
  };
}

afterEach(() => {
  controllers
    .splice(0)
    .forEach((controller) => controller.dispose());
  vi.useRealTimers();
});

describe("peer recovery after room signaling resumes", () => {
  it("does not interrupt the initial negotiation just because the browser focuses", async () => {
    const h = harness(false, false);
    h.setPeerStatus("created");
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(h.reconnect).not.toHaveBeenCalled();
    h.signal("connected");
    await vi.waitFor(() =>
      expect(h.reconnect).toHaveBeenCalledOnce(),
    );
  });

  it("recovers a disconnected peer without a focus or online event", async () => {
    const h = harness();
    h.signal("connected");
    await vi.waitFor(() =>
      expect(h.reconnect).toHaveBeenCalledOnce(),
    );
  });

  it("keeps an established media connection when only signaling was interrupted", async () => {
    const h = harness(true);
    h.signal("connected");
    await Promise.resolve();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.resetSession).not.toHaveBeenCalled();
  });

  it("waits for signaling without spending WebRTC retries", async () => {
    vi.useFakeTimers();
    const h = harness();
    const recovery = h.controller.handleDisconnection();
    await vi.advanceTimersByTimeAsync(
      SIGNALING_CONNECTION_TIMEOUT_MS * 3,
    );
    expect(h.reconnect).not.toHaveBeenCalled();
    h.signal("connected");
    await recovery;
    expect(h.reconnect).toHaveBeenCalledOnce();
  });

  it("does not start another connection after cancelling a signaling wait", async () => {
    const h = harness();
    const recovery = h.controller.handleDisconnection();
    h.controller.dispose();
    h.signal("connected");
    await recovery;
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});
