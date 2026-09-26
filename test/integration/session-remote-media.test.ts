// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { reconcile } from "solid-js/store";
import { SessionService } from "@/libs/application/session-service";
import type { ClientService } from "@/libs/domain/client";
import type { SignalingService } from "@/libs/domain/signaling";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { createMeetingSources } from "@/routes/home/components/meeting-sources";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

class Track extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  enabled = true;
  muted = false;
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly id: string,
    readonly kind: "audio" | "video",
  ) {
    super();
  }
}

class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
  remoteRemove(track: Track) {
    this.tracks = this.tracks.filter(
      (item) => item !== asTrack(track),
    );
    this.dispatchEvent(
      Object.assign(new Event("removetrack"), { track }),
    );
  }
}
const asTrack = (track: Track) =>
  track as unknown as MediaStreamTrack;
const stream = (...tracks: Track[]) =>
  new Stream(tracks.map(asTrack));

// Deterministic event replay, not a browser SDP/ICE implementation. This test
// covers the real PeerSession -> SessionService -> store -> meeting projection
// path, independently of whether a browser produces a conflicting local offer.
class PeerConnection extends EventTarget {
  private configuration: RTCConfiguration = {};
  readonly getConfiguration = () => this.configuration;
  readonly setConfiguration = vi.fn(
    (configuration: RTCConfiguration) => {
      this.configuration = configuration;
    },
  );
  connectionState: RTCPeerConnectionState = "connected";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = {
    type: "answer",
    sdp: "initial-answer",
  };
  remoteDescription: RTCSessionDescriptionInit | null = {
    type: "offer",
    sdp: "initial-offer",
  };
  readonly getSenders = () => [];
  readonly addTransceiver = vi.fn();
  readonly createOffer = vi.fn(async () => ({
    type: "offer" as const,
    sdp: "local-offer",
  }));
  readonly setLocalDescription = vi.fn(async () => {
    this.localDescription = {
      type: "offer",
      sdp: "local-offer",
    };
    this.signalingState = "have-local-offer";
  });
  close() {
    this.connectionState = "closed";
    this.signalingState = "closed";
  }
  receive(track: Track, source: Stream) {
    this.dispatchEvent(
      Object.assign(new Event("track"), {
        track,
        streams: [source],
        receiver: {},
      }),
    );
  }
}

beforeEach(() => {
  setAppState("session", "sessions", reconcile({}));
  setAppState("session", "clientViewData", reconcile({}));
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCRtpSender", undefined);
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("remote media presentation across peer recovery", () => {
  it.each([false, true])(
    "keeps new and removed remote videos reactive after recovery (local offer rejected=%s)",
    async (rejectLocalOffer) => {
      const sender = {
        clientId: "local",
        targetClientId: "remote",
        status: "connected",
        sendSignal: vi.fn(async () => {}),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        close: vi.fn(),
      } satisfies SignalingService;
      const service = new SessionService({
        loadIceServers: async () => [],
      });
      service.setClientService({
        info: { clientId: "local", createdAt: 1 },
        createSender: () => sender,
        removeSender: vi.fn(),
        addEventListener: vi.fn(),
        close: vi.fn(),
      } as unknown as ClientService);
      let dispose = () => {};
      try {
        const session = await service.addClient({
          clientId: "remote",
          createdAt: 2,
          name: "Remote",
          avatar: null,
        });
        const sources = createRoot((cleanup) => {
          dispose = cleanup;
          return createMeetingSources(() =>
            Object.values(appState.session.clientViewData)
              .filter(Boolean)
              .map((client) => ({
                id: client.clientId,
                name: client.name,
                stream: client.stream,
                placeholder:
                  client.streamState === "placeholder",
              })),
          );
        });
        const videoIds = () =>
          sources().flatMap((source) =>
            source.track ? [source.track.id] : [],
          );
        const viewIds = () =>
          appState.session.clientViewData.remote.stream
            ?.getTracks()
            .map((track) => track.id) ?? [];
        await session.listen();
        const old =
          session.peerConnection as unknown as PeerConnection;
        const oldVideo = new Track("old-camera", "video");
        const oldStream = stream(oldVideo);
        old.receive(oldVideo, oldStream);
        expect(videoIds()).toEqual(["old-camera"]);

        // Reuse the same PeerSession and the same meeting subscription, replacing
        // only its PC. The harness supplies connection readiness; no ICE is run.
        await session.reconnect({ initiate: false });
        const current =
          session.peerConnection as unknown as PeerConnection;
        expect(current).not.toBe(old);
        expect(oldVideo.stop).toHaveBeenCalledOnce();
        expect(videoIds()).toEqual([]);

        const camera = new Track("new-camera", "video");
        const audio = new Track("new-microphone", "audio");
        const cameraStream = stream(camera, audio);
        current.receive(camera, cameraStream);
        current.receive(audio, cameraStream);
        expect(videoIds()).toEqual(["new-camera"]);

        if (rejectLocalOffer) {
          const error = new DOMException(
            "A BUNDLE group contains a codec collision for header extension id=1",
            "InvalidAccessError",
          );
          // Inject rejection at the native API boundary. Receiving must not
          // depend on a later successful local offer or a media-view remount.
          current.setLocalDescription.mockRejectedValueOnce(
            error,
          );
          current.dispatchEvent(
            new Event("negotiationneeded"),
          );
          for (let tick = 0; tick < 40; tick++)
            await Promise.resolve();
          expect(console.error).toHaveBeenCalledWith(
            "[PeerNegotiation] operation failed",
            expect.objectContaining({ peerId: "remote" }),
            error,
          );
          expect(sender.sendSignal).not.toHaveBeenCalled();
        }

        const screen = new Track("new-screen", "video");
        const screenStream = stream(screen);
        current.receive(screen, screenStream);
        expect(viewIds()).toEqual([
          "new-camera",
          "new-microphone",
          "new-screen",
        ]);
        expect(videoIds()).toEqual([
          "new-camera",
          "new-screen",
        ]);

        // Retired PC/track/stream events must not erase the replacement's view.
        old.receive(
          new Track("late-old-video", "video"),
          oldStream,
        );
        oldStream.remoteRemove(oldVideo);
        oldVideo.dispatchEvent(new Event("ended"));
        expect(videoIds()).toEqual([
          "new-camera",
          "new-screen",
        ]);

        screenStream.remoteRemove(screen);
        expect(videoIds()).toEqual(["new-camera"]);
        cameraStream.remoteRemove(camera);
        expect(videoIds()).toEqual([]);
        expect(viewIds()).toEqual(["new-microphone"]);
        expect(sources()[0].kind).toBe("participant");
        cameraStream.remoteRemove(audio);
        expect(viewIds()).toEqual([]);

        const restarted = new Track(
          "restarted-video",
          "video",
        );
        current.receive(restarted, stream(restarted));
        expect(videoIds()).toEqual(["restarted-video"]);
        expect(session.peerConnection).toBe(current);
        expect(current.createOffer).not.toHaveBeenCalled();
        expect(
          current.setLocalDescription,
        ).toHaveBeenCalledTimes(rejectLocalOffer ? 1 : 0);
      } finally {
        service.destoryAllSession();
        dispose();
      }
    },
  );
});
