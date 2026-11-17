import { afterEach, expect, it, vi } from "vitest";
import { cameraPublication } from "@/libs/domain/camera-publication";

const timing = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("@/libs/domain/rtp-encoded-media", () => ({
  RtpEncodedMediaTrack: timing,
}));
vi.mock("@/libs/domain/browser-video-quality", () => ({
  browserQualitySource: () => ({
    limits: { maxBitrate: 1000000 },
  }),
  setBrowserVideoLimits: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("releases camera timing on failed offers and repeated close without stopping borrowed capture", async () => {
  const close = vi.fn();
  const dispose = vi.fn();
  const createOffer = vi.fn(async () => ({
    type: "offer",
    sdp: "offer",
  }));
  class Peer {
    localDescription = { sdp: "offer" };
    addTransceiver = () => ({
      sender: {},
      setCodecPreferences: vi.fn(),
    });
    setLocalDescription = vi.fn();
    createOffer = createOffer;
    close = close;
  }
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: () => ({
      codecs: [{ mimeType: "video/VP8" }],
    }),
  });
  timing.install.mockReturnValue({ dispose });
  const track = {
    id: "camera",
    kind: "video",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const publication = cameraPublication(
    track,
    undefined,
    () => ({
      limits: {
        maxWidth: 1280,
        maxHeight: 720,
        frameRate: 30,
        maxBitrate: 1000000,
      },
      videoCodec: null,
      audioCodec: null,
      degradationPreference: "balanced",
    }),
  );
  const offer = () =>
    publication.offer(
      "viewer",
      [],
      false,
      undefined,
      undefined,
      { video: "video/vp8", audio: "" },
    );
  createOffer.mockRejectedValueOnce(
    new Error("offer failed"),
  );
  await expect(offer()).rejects.toThrow("offer failed");
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 2; n++) {
    await offer();
    await publication.closePeer("unrelated");
    expect(dispose).toHaveBeenCalledTimes(n + 1);
    await publication.closePeer("viewer");
    await publication.closePeer("viewer");
    expect(dispose).toHaveBeenCalledTimes(n + 2);
    expect(close).toHaveBeenCalledTimes(n + 2);
  }
  expect(track.stop).not.toHaveBeenCalled();
});
