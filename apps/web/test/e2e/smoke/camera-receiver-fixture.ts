import type { NativeMediaReceive } from "@weblink/platform";

// Browser CI exercises the production negotiation and track routing with real RTP.
// The same scenario running inside WebView2 uses the installed native adapter.
export const cameraReceiverFixture: NativeMediaReceive = {
  allowBrowserFallback: false,
  codecs: async () => ["video/vp8", "audio/opus"],
  async open(configuration, emit, signal, source) {
    if (!source)
      throw new Error(
        "Expected explicit native receiver source",
      );
    const pc = new RTCPeerConnection(configuration);
    const stream = new MediaStream();
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.candidate)
        emit({
          type: "candidate",
          candidate: candidate.toJSON(),
        });
    };
    pc.ontrack = ({ track }) => {
      stream.addTrack(track);
      emit({ type: "track" });
    };
    pc.onconnectionstatechange = () =>
      emit({ type: "state", state: pc.connectionState });
    const close = () => pc.close();
    signal.addEventListener("abort", close, { once: true });
    return {
      stream,
      async answer(sdp) {
        await pc.setRemoteDescription({
          type: "offer",
          sdp,
        });
        await pc.setLocalDescription(
          await pc.createAnswer(),
        );
        return pc.localDescription!.sdp;
      },
      addIceCandidate: (candidate) =>
        pc.addIceCandidate(candidate),
      stats: async () => [
        ...(await pc.getStats()).values(),
      ],
      send: async () => {
        throw new Error("Unexpected camera data channel");
      },
      close,
    };
  },
};
