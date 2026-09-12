import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerNegotiationController } from "@/libs/core/peer-negotiation";
import type { SignalingService } from "@/libs/core/services/type";

const makeSender = () =>
  ({
    clientId: "local",
    targetClientId: "remote",
    status: "connected",
    sendSignal: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
  }) as unknown as SignalingService;

const makeOfferPeerConnection = () =>
  ({
    signalingState: "stable",
    connectionState: "new",
    createOffer: vi.fn(async () => ({
      type: "offer" as const,
      sdp: "offer-sdp",
    })),
    setLocalDescription: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}),
    close: vi.fn(),
  }) as unknown as RTCPeerConnection;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeerNegotiationController", () => {
  it("binds local SDP and ICE to its connection generation", async () => {
    const sender = makeSender();
    const pc = makeOfferPeerConnection();
    let current: RTCPeerConnection | null = pc;
    const negotiation = new PeerNegotiationController({
      sender,
      polite: false,
      getPeerConnection: () => current,
      createGeneration: () => "generation-a",
    });

    expect(negotiation.startConnection(pc)).toBe(
      "generation-a",
    );
    await negotiation.sendOffer(pc);
    await negotiation.sendCandidate(pc, {
      candidate: "candidate-a",
    });

    expect(sender.sendSignal).toHaveBeenNthCalledWith(1, {
      type: "offer",
      data: JSON.stringify({
        sdp: "offer-sdp",
        generation: "generation-a",
      }),
    });
    expect(sender.sendSignal).toHaveBeenNthCalledWith(2, {
      type: "candidate",
      data: JSON.stringify({
        candidate: { candidate: "candidate-a" },
        generation: "generation-a",
      }),
    });

    current = null;
    negotiation.reset();
  });

  it("queues candidates until their offer generation is adopted", async () => {
    vi.stubGlobal(
      "RTCSessionDescription",
      class {
        type: RTCSdpType;
        sdp: string;
        constructor(init: RTCSessionDescriptionInit) {
          this.type = init.type;
          this.sdp = init.sdp ?? "";
        }
      },
    );
    vi.stubGlobal(
      "RTCIceCandidate",
      class {
        constructor(readonly init: RTCIceCandidateInit) {}
      },
    );

    const sender = makeSender();
    let signalingState: RTCSignalingState = "stable";
    let remoteDescription: RTCSessionDescription | null =
      null;
    let localDescription: RTCSessionDescription | null =
      null;
    const addIceCandidate = vi.fn(async () => {});
    const pc = {
      get signalingState() {
        return signalingState;
      },
      get remoteDescription() {
        return remoteDescription;
      },
      get localDescription() {
        return localDescription;
      },
      setRemoteDescription: vi.fn(
        async (description: RTCSessionDescription) => {
          remoteDescription = description;
          signalingState = "have-remote-offer";
        },
      ),
      setLocalDescription: vi.fn(async () => {
        localDescription = {
          type: "answer",
          sdp: "answer-sdp",
        } as RTCSessionDescription;
        signalingState = "stable";
      }),
      addIceCandidate,
    } as unknown as RTCPeerConnection;
    const negotiation = new PeerNegotiationController({
      sender,
      polite: true,
      getPeerConnection: () => pc,
      createGeneration: () => "local-generation",
    });
    negotiation.startConnection(pc);

    await negotiation.handleSignal({
      type: "candidate",
      data: {
        candidate: { candidate: "candidate-a" },
        generation: "remote-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });
    expect(addIceCandidate).not.toHaveBeenCalled();

    await negotiation.handleSignal({
      type: "offer",
      data: {
        sdp: "remote-offer",
        generation: "remote-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });

    expect(negotiation.generation).toBe(
      "remote-generation",
    );
    expect(addIceCandidate).toHaveBeenCalledTimes(1);
    expect(sender.sendSignal).toHaveBeenCalledWith({
      type: "answer",
      data: JSON.stringify({
        sdp: "answer-sdp",
        generation: "remote-generation",
      }),
    });
  });

  it("does not finish an asynchronous offer on a replaced peer connection", async () => {
    vi.stubGlobal(
      "RTCSessionDescription",
      class {
        constructor(
          readonly init: RTCSessionDescriptionInit,
        ) {}
      },
    );

    let releaseRemoteDescription: (() => void) | undefined;
    const remoteDescriptionPending = new Promise<void>(
      (resolve) => {
        releaseRemoteDescription = resolve;
      },
    );
    const oldSetLocalDescription = vi.fn(async () => {});
    const oldPeerConnection = {
      signalingState: "stable",
      setRemoteDescription: vi.fn(
        () => remoteDescriptionPending,
      ),
      setLocalDescription: oldSetLocalDescription,
    } as unknown as RTCPeerConnection;
    const newPeerConnection = {
      signalingState: "stable",
    } as unknown as RTCPeerConnection;
    let current: RTCPeerConnection | null =
      oldPeerConnection;
    let nextGeneration = "old-generation";
    const sender = makeSender();
    const negotiation = new PeerNegotiationController({
      sender,
      polite: true,
      getPeerConnection: () => current,
      createGeneration: () => nextGeneration,
    });
    negotiation.startConnection(oldPeerConnection);

    const handling = negotiation.enqueueSignal({
      type: "offer",
      data: {
        sdp: "old-offer",
        generation: "old-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });
    const queuedLegacyCandidate = negotiation.enqueueSignal(
      {
        type: "candidate",
        data: {
          candidate: { candidate: "legacy-candidate" },
        },
        clientId: "remote",
        targetClientId: "local",
      },
    );
    await Promise.resolve();

    current = newPeerConnection;
    negotiation.reset();
    nextGeneration = "new-generation";
    negotiation.startConnection(newPeerConnection);
    releaseRemoteDescription?.();
    await Promise.all([handling, queuedLegacyCandidate]);

    expect(oldSetLocalDescription).not.toHaveBeenCalled();
    expect(sender.sendSignal).not.toHaveBeenCalled();
    expect(negotiation.generation).toBe("new-generation");
  });
});
