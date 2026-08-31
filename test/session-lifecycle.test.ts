import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { PeerSession } from "@/libs/core/session";
import type {
  ClientService,
  SignalingService,
  TransferClient,
} from "@/libs/core/services/type";
import { SessionService } from "@/libs/services/session-service";
import { setAppState } from "@/libs/state/app-state";

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

const makePeerConnection = (
  createOffer: () => Promise<RTCSessionDescriptionInit>,
) =>
  ({
    signalingState: "stable",
    connectionState: "new",
    createOffer,
    setLocalDescription: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    close: vi.fn(),
    getSenders: () => [],
  }) as unknown as RTCPeerConnection;

beforeEach(() => {
  setAppState("session", "sessions", reconcile({}));
  setAppState("session", "clientViewData", reconcile({}));
  setAppState(
    "session",
    "clientServiceStatus",
    "disconnected",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PeerSession lifecycle", () => {
  it("resets makingOffer after renegotiation fails", async () => {
    const sender = makeSender("local", "remote");
    const session = new PeerSession(sender, {
      polite: false,
    });
    const createOffer = vi
      .fn<() => Promise<RTCSessionDescriptionInit>>()
      .mockRejectedValueOnce(new Error("offer failed"))
      .mockResolvedValueOnce({
        type: "offer",
        sdp: "offer-sdp",
      });
    const pc = makePeerConnection(createOffer);
    (session as any).peerConnection = pc;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await session.renegotiate();

    expect((session as any).makingOffer).toBe(false);

    await session.renegotiate();

    expect(createOffer).toHaveBeenCalledTimes(2);
    expect((session as any).makingOffer).toBe(false);
    session.close();
  });

  it("propagates an asynchronous listen failure on reconnect", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const listenError = new Error("listen failed");
    vi.spyOn(session, "listen").mockRejectedValueOnce(
      listenError,
    );
    const connect = vi.spyOn(session, "connect");

    await expect(session.reconnect()).rejects.toBe(
      listenError,
    );

    expect(connect).not.toHaveBeenCalled();
    session.close();
  });

  it("connects after the offer and peer connection are ready", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    let connectionState: RTCPeerConnectionState = "new";
    let onConnectionStateChange: (() => void) | undefined;
    const close = vi.fn();
    const pc = {
      signalingState: "stable",
      get connectionState() {
        return connectionState;
      },
      createOffer: vi.fn(async () => ({
        type: "offer" as const,
        sdp: "offer-sdp",
      })),
      setLocalDescription: vi.fn(async () => {
        connectionState = "connected";
        onConnectionStateChange?.();
      }),
      addEventListener: vi.fn(
        (type: string, listener: EventListener) => {
          if (type === "connectionstatechange") {
            onConnectionStateChange =
              listener as () => void;
          }
        },
      ),
      close,
      getSenders: () => [],
    } as unknown as RTCPeerConnection;
    (session as any).peerConnection = pc;
    (session as any).controller = new AbortController();
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockResolvedValue(
      {} as RTCDataChannel,
    );

    await session.connect();

    expect((session as any).status).toBe("connected");
    expect((session as any).makingOffer).toBe(false);
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("aborts connect while offer creation is pending", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const pc = makePeerConnection(
      () =>
        new Promise<RTCSessionDescriptionInit>(() => {}),
    );
    const controller = new AbortController();
    (session as any).peerConnection = pc;
    (session as any).controller = controller;
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise<RTCDataChannel>(() => {}),
    );

    const connectPromise = session.connect();
    controller.abort();

    await expect(connectPromise).rejects.toThrow(
      "connect aborted",
    );
    expect((session as any).makingOffer).toBe(false);
    expect(pc.close).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("cleans up connect state when offer creation fails", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const pc = makePeerConnection(() =>
      Promise.reject(new Error("offer failed")),
    );
    (session as any).peerConnection = pc;
    (session as any).controller = new AbortController();
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise<RTCDataChannel>(() => {}),
    );

    await expect(session.connect()).rejects.toThrow(
      "Failed to create and send offer: offer failed",
    );

    expect((session as any).makingOffer).toBe(false);
    expect(pc.close).toHaveBeenCalledTimes(1);
    session.close();
  });
});

describe("SessionService lifecycle", () => {
  it("removes a remotely keyed session when it closes itself", async () => {
    const removeSender = vi.fn();
    const localClient: TransferClient = {
      clientId: "local",
      name: "Local",
      avatar: null,
      createdAt: 1,
    };
    const remoteClient: TransferClient = {
      clientId: "remote",
      name: "Remote",
      avatar: null,
      createdAt: 2,
    };
    const clientService = {
      info: localClient,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createSender: vi.fn(() =>
        makeSender("local", "remote"),
      ),
      removeSender,
      listenForJoin: vi.fn(),
      listenForLeave: vi.fn(),
      createClient: async () => {},
      updateClient: async () => {},
      close: vi.fn(),
    } satisfies ClientService;
    const service = new SessionService({
      loadIceServers: async () => [],
    });
    service.setClientService(clientService);
    const session = await service.addClient(remoteClient);

    expect(service.sessions.remote).toBe(session);

    expect(
      service.updateClientProfile({
        clientId: "remote",
        name: "Updated remote",
        avatar: "data:image/png;base64,avatar",
      }),
    ).toBe(true);
    expect(service.clientViewData.remote).toMatchObject({
      name: "Updated remote",
      avatar: "data:image/png;base64,avatar",
    });

    session.close();

    expect(service.sessions.remote).toBeUndefined();
    expect(service.clientViewData.remote).toBeUndefined();
    expect(removeSender).toHaveBeenCalledTimes(1);
    expect(removeSender).toHaveBeenCalledWith("remote");
    expect(removeSender).not.toHaveBeenCalledWith("local");
    service.removeService();
  });
});
