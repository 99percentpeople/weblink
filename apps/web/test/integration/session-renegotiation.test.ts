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
  RawSignal,
  SignalingService,
} from "@/libs/domain/signaling";

async function flush() {
  for (let index = 0; index < 40; index++)
    await Promise.resolve();
}

async function harness() {
  let revision = 1;
  const pc = Object.assign(new EventTarget(), {
    signalingState: "stable" as RTCSignalingState,
    connectionState: "connected" as RTCPeerConnectionState,
    localDescription:
      null as RTCSessionDescriptionInit | null,
    remoteDescription:
      null as RTCSessionDescriptionInit | null,
    getSenders: () => [],
    addTransceiver: vi.fn(),
    close: vi.fn(),
    createOffer: vi.fn(),
    setLocalDescription: vi.fn(async () => {
      pc.localDescription = {
        type: "offer",
        sdp: `offer-${revision}`,
      };
      pc.signalingState = "have-local-offer";
    }),
  });
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(() => pc),
  );
  const sendSignal = vi.fn(
    async (_signal: RawSignal) => {},
  );
  const sender = {
    clientId: "local",
    targetClientId: "remote",
    status: "connected",
    sendSignal,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  } as unknown as SignalingService;
  const session = new PeerSession(sender, {
    polite: false,
  });
  await session.listen();
  return {
    pc,
    session,
    sendSignal,
    // Native negotiationneeded coalescing is verified by the real browser
    // recovery suite. This fixture tests only our event -> controller boundary.
    change() {
      revision++;
    },
    async negotiationNeeded() {
      pc.dispatchEvent(new Event("negotiationneeded"));
      await flush();
    },
    established() {
      pc.localDescription = {
        type: "answer",
        sdp: "initial-answer",
      };
      pc.remoteDescription = {
        type: "offer",
        sdp: "initial-offer",
      };
    },
    answer() {
      pc.remoteDescription = {
        type: "answer",
        sdp: "answer",
      };
      pc.signalingState = "stable";
      pc.dispatchEvent(new Event("signalingstatechange"));
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("native media negotiation driver", () => {
  it("waits for initial signaling, then sends unmodified browser SDP through the same driver", async () => {
    const h = await harness();
    try {
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).not.toHaveBeenCalled();
      h.established();
      h.change();
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledOnce();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledWith();
      expect(h.pc.createOffer).not.toHaveBeenCalled();
      expect(
        JSON.parse(h.sendSignal.mock.calls[0][0].data).sdp,
      ).toBe(h.pc.localDescription!.sdp);
    } finally {
      h.session.close();
    }
  });

  it("leaves pending media changes to the next native event instead of a second stable-state scheduler", async () => {
    const h = await harness();
    try {
      h.established();
      await h.negotiationNeeded();
      h.change();
      h.change();
      h.change();
      h.answer();
      await flush();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledOnce();
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(h.sendSignal.mock.calls.at(-1)![0].data)
          .sdp,
      ).toBe("offer-4");
      h.answer();
      await flush();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledTimes(2);
    } finally {
      h.session.close();
    }
  });

  it("rechecks signaling state when an event reaches the SDP queue", async () => {
    const h = await harness();
    try {
      h.established();
      h.pc.dispatchEvent(new Event("negotiationneeded"));
      h.pc.signalingState = "have-remote-offer";
      await flush();
      expect(
        h.pc.setLocalDescription,
      ).not.toHaveBeenCalled();
      h.answer();
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledOnce();
    } finally {
      h.session.close();
    }
  });

  it("cancels retired event listeners and never sends an old asynchronous local description", async () => {
    const h = await harness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.established();
    h.pc.setLocalDescription.mockImplementationOnce(
      async () => {
        await pending;
        h.pc.localDescription = {
          type: "offer",
          sdp: "retired",
        };
      },
    );
    await h.negotiationNeeded();
    h.session.close();
    release();
    await flush();
    await h.negotiationNeeded();
    expect(h.sendSignal).not.toHaveBeenCalled();
    expect(h.pc.setLocalDescription).toHaveBeenCalledOnce();
  });

  it("logs rejected native SDP without rewriting, retrying or closing working media", async () => {
    const h = await harness();
    try {
      h.established();
      const error = new DOMException(
        "header extension id=1",
        "InvalidAccessError",
      );
      h.pc.setLocalDescription.mockRejectedValueOnce(error);
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledOnce();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledWith();
      expect(h.pc.createOffer).not.toHaveBeenCalled();
      expect(h.sendSignal).not.toHaveBeenCalled();
      expect(h.pc.close).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        "[PeerNegotiation] operation failed",
        expect.objectContaining({
          operation: "negotiate local changes",
        }),
        error,
      );
      await flush();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledOnce();
      h.change();
      await h.negotiationNeeded();
      expect(
        h.pc.setLocalDescription,
      ).toHaveBeenCalledTimes(2);
    } finally {
      h.session.close();
    }
  });
});
