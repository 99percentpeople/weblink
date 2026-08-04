import { describe, expect, it, vi } from "vitest";
import { PeerSession } from "@/libs/core/session";
import type { SignalingService } from "@/libs/core/services/type";

if (typeof window === "undefined") {
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  };
}

if (typeof document === "undefined") {
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const makeSender = (
  clientId: string,
  targetClientId: string,
): SignalingService =>
  ({
    clientId,
    targetClientId,
    get status() {
      return "connected";
    },
    sendSignal: async () => {},
    addEventListener: ((..._args: any[]) => {}) as any,
    removeEventListener: ((..._args: any[]) => {}) as any,
    close: () => {},
  }) as SignalingService;

const makeStream = (id: string) =>
  ({
    id,
    addEventListener: () => {},
    getTracks: () => [],
  }) as unknown as MediaStream;

describe("PeerSession stream management", () => {
  it("does not create fallback stream when local stream is null", () => {
    const session = new PeerSession(makeSender("a", "b"), {
      polite: false,
    });
    (session as any).localStream = makeStream("media-1");
    (session as any).lastLocalStreamState = "media";

    session.setStream(null);

    expect((session as any).localStream).toBeNull();
    expect(
      (session as any).lastLocalStreamState,
    ).toBeNull();
    expect((session as any).outgoingQueue).toHaveLength(0);
  });

  it("syncs null stream to transceivers when pc exists", () => {
    const session = new PeerSession(makeSender("a", "b"), {
      polite: false,
    });
    const pc = {
      getSenders: () => [],
    } as unknown as RTCPeerConnection;
    (session as any).peerConnection = pc;
    (session as any).localStream = makeStream("media-2");

    const renegotiate = vi.fn();
    (session as any).renegotiate = renegotiate;

    session.setStream(null);

    expect((session as any).localStream).toBeNull();
    expect(renegotiate).toHaveBeenCalledTimes(1);
  });

  it("removes the sender associated with a removed track", () => {
    const session = new PeerSession(makeSender("a", "b"), {
      polite: false,
    });
    const track = {
      id: "track-1",
      kind: "audio",
      addEventListener: () => {},
    } as unknown as MediaStreamTrack;
    const sender = { track } as RTCRtpSender;
    const addTrack = vi.fn(() => sender);
    const removeTrack = vi.fn();
    const pc = {
      addTrack,
      removeTrack,
    } as unknown as RTCPeerConnection;

    let removeTrackListener:
      | ((event: { track: MediaStreamTrack }) => void)
      | undefined;
    const stream = {
      id: "media-3",
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (
          type === "removetrack" &&
          typeof listener === "function"
        ) {
          removeTrackListener =
            listener as unknown as (event: {
              track: MediaStreamTrack;
            }) => void;
        }
      },
      getTracks: () => [track],
    } as unknown as MediaStream;

    (session as any).peerConnection = pc;
    (session as any).renegotiate = vi.fn();

    session.setStream(stream);
    removeTrackListener?.({ track });

    expect(addTrack).toHaveBeenCalledWith(track, stream);
    expect(removeTrack).toHaveBeenCalledTimes(1);
    expect(removeTrack).toHaveBeenCalledWith(sender);
  });
});
