import type { NativeSendCodecs } from "@weblink/platform";
import {
  browserCodecs,
  commonCodecs,
} from "./media-codecs";
import type { MediaPublication } from "./media-publication";
import {
  setBrowserVideoLimits,
  browserQualitySource,
} from "./browser-video-quality";
import type { VideoQualityLimits } from "./video-quality";
import { readBrowserVideoStats } from "./video-stats";

export interface CameraSettings {
  limits: VideoQualityLimits;
  videoCodec: string | null;
  audioCodec: string | null;
  degradationPreference: RTCDegradationPreference;
}

export function cameraCodecs(
  receiver:
    | import("./protocol/media-codecs").MediaDecodeCapabilities
    | undefined,
  settings: CameraSettings,
  withMicrophone: boolean,
  excluded: readonly string[] = [],
): NativeSendCodecs | undefined {
  function select(
    kind: "video" | "audio",
    preferred: string | null,
  ) {
    return commonCodecs(kind, browserCodecs("send", kind), [
      receiver,
    ]).find(
      (c) =>
        (!preferred || c === preferred.toLowerCase()) &&
        (kind !== "video" || !excluded.includes(c)),
    );
  }
  const video = select("video", settings.videoCodec);
  const audio = withMicrophone
    ? select("audio", settings.audioCodec)
    : "";
  return video && audio !== undefined
    ? { video, audio }
    : undefined;
}

/** One viewer's send-only connection. Capture tracks are borrowed from the meeting. */
export function cameraPublication(
  camera: MediaStreamTrack,
  microphone: MediaStreamTrack | undefined,
  settings: () => CameraSettings,
): MediaPublication {
  let active:
    | {
        id: string;
        pc: RTCPeerConnection;
        video: RTCRtpSender;
      }
    | undefined;
  const limits = () =>
    browserQualitySource(camera, "", settings().limits)
      .limits;
  function sendTrack(
    pc: RTCPeerConnection,
    track: MediaStreamTrack,
    codec: string,
  ) {
    const video = track.kind === "video";
    const transceiver = pc.addTransceiver(track, {
      direction: "sendonly",
      sendEncodings: [
        video
          ? {
              maxBitrate: limits().maxBitrate,
              priority: "high",
            }
          : { priority: "high" },
      ],
    });
    const formats =
      RTCRtpSender.getCapabilities(track.kind)?.codecs ??
      [];
    const selected = formats.filter(
      (c) => c.mimeType.toLowerCase() === codec,
    );
    if (!selected.length)
      throw new Error(
        "Camera connection codec unavailable: " + codec,
      );
    transceiver.setCodecPreferences([
      ...selected,
      ...formats.filter((c) =>
        /\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType),
      ),
    ]);
    return transceiver.sender;
  }
  return {
    sourceId: camera.id,
    videoLimits: limits,
    selectCodecs(receiver, excluded = []) {
      const codecs = cameraCodecs(
        receiver,
        settings(),
        !!microphone,
        excluded,
      );
      if (!codecs)
        throw new Error("No common camera codec");
      return codecs;
    },
    async offer(
      id,
      iceServers,
      relay,
      candidate,
      _control,
      codecs?: NativeSendCodecs,
    ) {
      if (!codecs || active)
        throw new Error("Invalid camera offer");
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: relay ? "relay" : "all",
      });
      try {
        pc.onicecandidate = ({ candidate: ice }) => {
          if (ice?.candidate) candidate?.(ice.toJSON());
        };
        const video = sendTrack(pc, camera, codecs.video);
        active = { id, pc, video };
        if (microphone)
          sendTrack(pc, microphone, codecs.audio);
        await pc.setLocalDescription(
          await pc.createOffer(),
        );
        return pc.localDescription!.sdp;
      } catch (error) {
        if (active?.id === id) active = undefined;
        pc.close();
        throw error;
      }
    },
    async answer(id, sdp) {
      if (active?.id === id)
        await active.pc.setRemoteDescription({
          type: "answer",
          sdp,
        });
    },
    async addIceCandidate(id, candidate) {
      if (active?.id === id)
        await active.pc.addIceCandidate(candidate);
    },
    async closePeer(id) {
      if (active?.id !== id) return;
      active.pc.onicecandidate = null;
      active.pc.close();
      active = undefined;
    },
    async updatePeerVideoSettings(id, preference) {
      if (active?.id !== id)
        throw new Error("Camera connection changed");
      await setBrowserVideoLimits(
        active.video,
        limits(),
        preference,
        settings().degradationPreference,
      );
    },
    async getSenderStats(id) {
      return active && active.id === id
        ? readBrowserVideoStats(active.pc, camera, "send")
        : [];
    },
  };
}
