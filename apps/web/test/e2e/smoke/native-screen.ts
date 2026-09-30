import { createRoot } from "solid-js";
import { liveVideoSettingsCheck } from "./live-video-settings";
import { streamStatisticsCheck } from "./stream-statistics";
import { readBrowserVideoStats } from "@/libs/domain/video-stats";
import { SessionService } from "@/libs/application/session-service";
import { createNativeScreenStream } from "@/libs/application/native-screen-service";
import { appState } from "@/libs/state/app-state";
import { createMeetingSources } from "@/routes/home/components/meeting-sources";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { ClientService } from "@/libs/domain/client";
import type {
  RawSignal,
  SignalingService,
  SignalingServiceEventMap,
} from "@/libs/domain/signaling";
import type {
  CaptureStatus,
  NativeCapture,
  NativeScreenShare,
} from "@weblink/platform";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = performance.now() + 10000;
  while (!(await check())) {
    if (performance.now() > deadline)
      throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
class Sender implements SignalingService {
  status = "connected" as const;
  remote!: Sender;
  readonly events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  addEventListener = this.events.addEventListener.bind(
    this.events,
  );
  removeEventListener =
    this.events.removeEventListener.bind(this.events);
  constructor(
    readonly clientId: string,
    readonly targetClientId: string,
  ) {}
  async sendSignal(signal: RawSignal) {
    queueMicrotask(() =>
      this.remote.events.dispatchEvent("signal", {
        ...signal,
        clientId: this.clientId,
        targetClientId: this.targetClientId,
        data: JSON.parse(signal.data),
      }),
    );
  }
  close() {}
}

// Substitute only the native host with a browser sender. SDP, ICE, RTP, the
// native publication adapter, room session integration and view projection are real.
// Rust has a separate Windows libwebrtc regression with the same unreachable STUN.
function source() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    ctx.fillStyle = frame++ % 2 ? "blue" : "green";
    ctx.fillRect(0, 0, 320, 180);
  };
  draw();
  const timer = setInterval(draw, 80);
  const stream = canvas.captureStream(10);
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.05;
  const output = audio.createMediaStreamDestination();
  tone.connect(gain).connect(output);
  tone.start();
  stream.addTrack(output.stream.getAudioTracks()[0]);
  let withAudio = false;
  const peers = new Map<string, RTCPeerConnection>();
  const offers: boolean[] = [];
  const status: CaptureStatus = {
    state: "running",
    sessionId: "test",
    source: null,
    frames: 1,
    width: 320,
    height: 180,
    fps: 10,
    elapsedMs: 0,
    lastFrameAgeMs: 0,
    stopReason: null,
    error: null,
  };
  const share: NativeScreenShare = {
    stats: async (_id, peerId) => {
      const samples = await readBrowserVideoStats(
        peers.get(peerId)!,
        stream.getVideoTracks()[0],
        "send",
      );
      return samples.map((s) => ({
        id: s.id,
        timestamp: s.timestamp,
        codec: s.codec ?? "",
        implementation: s.implementation ?? "",
        width: s.width ?? 0,
        height: s.height ?? 0,
        bytes: s.bytes ?? 0,
        frames: s.frames ?? 0,
        encodeFrames: s.encodeFrames ?? 0,
        encodeSeconds: s.encodeSeconds ?? 0,
      }));
    },
    updateVideoSettings: async (_id, settings) => {
      for (const track of stream.getVideoTracks()) {
        await track.applyConstraints({
          width: { max: settings.maxWidth },
          height: { max: settings.maxHeight },
          frameRate: { max: settings.frameRate },
        });
      }
    },
    encoders: async () => [],
    start: async (_source, options) => {
      withAudio = options?.audio === true;
      await audio.resume();
      return status;
    },
    codecs: async () => ["video/vp8"],
    offer: async (
      _id,
      peerId,
      iceServers,
      relayOnly,
      preview,
      onCandidate,
    ) => {
      offers.push(!!preview);
      const pc = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: relayOnly ? "relay" : "all",
      });
      peers.set(peerId, pc);
      for (const track of stream.getTracks())
        if (track.kind === "video" || withAudio)
          pc.addTrack(track, stream);
      pc.onicecandidate = (event) => {
        if (event.candidate?.candidate)
          onCandidate?.(event.candidate.toJSON());
      };
      await pc.setLocalDescription(await pc.createOffer());
      if (!onCandidate)
        await until(
          () => pc.iceGatheringState === "complete",
          "Non-trickle offer waited for unavailable STUN",
        );
      return pc.localDescription!.sdp;
    },
    answer: async (_id, peerId, sdp) => {
      await peers
        .get(peerId)!
        .setRemoteDescription({ type: "answer", sdp });
    },
    addIceCandidate: async (_id, peerId, candidate) => {
      await peers.get(peerId)!.addIceCandidate(candidate);
    },
    closePeer: async (_id, peerId) => {
      peers.get(peerId)?.close();
      peers.delete(peerId);
    },
  };
  const capture: NativeCapture = {
    thumbnail: async () =>
      new Blob([], { type: "image/png" }),
    backends: async () => ({ screen: [], window: [] }),
    sources: async () => [],
    start: async () => status,
    status: async () => status,
    stop: async () => {
      peers.forEach((pc) => pc.close());
      peers.clear();
      return status;
    },
  };
  return {
    share,
    capture,
    offers,
    peers,
    close() {
      tone.stop();
      void audio.close();
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      peers.forEach((pc) => pc.close());
    },
  };
}

async function scenario(
  polite: boolean,
  beforeJoin: boolean,
  withAudio = true,
) {
  // Both service instances use the shared test store with distinct peer IDs.
  // Each stream is scoped explicitly to its own managed session.
  const loadIceServers = async () => [
    { urls: "stun:127.0.0.1:9" },
  ];
  const a = new SessionService({ loadIceServers }),
    b = new SessionService({ loadIceServers });
  const sa = new Sender("native", "web"),
    sb = new Sender("web", "native");
  sa.remote = sb;
  sb.remote = sa;
  const time = polite ? 1 : 3;
  for (const [service, sender, createdAt] of [
    [a, sa, time],
    [b, sb, 2],
  ] as const)
    service.setClientService({
      info: { clientId: sender.clientId, createdAt },
      createSender: () => sender,
      removeSender: () => {},
      addEventListener: () => {},
      close: () => {},
    } as unknown as ClientService);
  const synthetic = source();
  const options = {
    audio: withAudio,
    maxWidth: 320,
    maxHeight: 180,
    frameRate: 10,
    maxBitrate: 1_000_000,
    codec: null,
    degradationPreference: "balanced" as const,
  };
  let stream: MediaStream | undefined;
  let dispose = () => {};
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  document.body.append(video);
  try {
    if (beforeJoin)
      stream = await createNativeScreenStream(
        synthetic.capture,
        synthetic.share,
        "synthetic",
        undefined,
        options,
      );
    const pa = await a.addClient({
      clientId: "web",
      createdAt: 2,
      name: "Web",
      avatar: null,
    });
    const pb = await b.addClient({
      clientId: "native",
      createdAt: time,
      name: "Native",
      avatar: null,
    });
    const sources = createRoot((cleanup) => {
      dispose = cleanup;
      return createMeetingSources(() => [
        {
          id: "native",
          name: "Native",
          stream:
            appState.session.clientViewData.native?.stream,
          nativeScreenStream:
            appState.session.clientViewData.native
              ?.nativeScreenStream,
        },
      ]);
    });
    if (stream) a.setSessionStream(pa, stream);
    await Promise.all([pa.listen(), pb.listen()]);
    await (polite ? pb : pa).connect();
    await until(
      () =>
        pa.isMessageChannelReady &&
        pb.isMessageChannelReady,
      "Room message channels failed",
    );
    const initial = [pa.peerConnection, pb.peerConnection];
    if (!stream) {
      stream = await createNativeScreenStream(
        synthetic.capture,
        synthetic.share,
        "synthetic",
        undefined,
        options,
      );
      a.setSessionStream(pa, stream);
    }
    const firstFrame = async () => {
      await until(
        () => sources().some((s) => s.kind === "screen"),
        "Native screen did not reach meeting state",
      );
      video.srcObject = sources().find(
        (s) => s.kind === "screen",
      )!.stream;
      const frames =
        video.getVideoPlaybackQuality().totalVideoFrames;
      await video.play();
      await until(
        () =>
          video.getVideoPlaybackQuality().totalVideoFrames >
          frames + 3,
        "Native RTP did not produce decoded frames",
      );
    };
    await firstFrame();
    if (polite && beforeJoin) {
      const remoteStream = sources().find(
        (s) => s.kind === "screen",
      )!.stream!;
      const remoteStats = await b.getVideoStats(
        remoteStream.getVideoTracks()[0],
      );
      assert(
        remoteStats.some(
          (batch) =>
            batch.direction === "receive" &&
            batch.samples.some(
              (sample) =>
                (sample.frames ?? 0) > 0 &&
                sample.decodeSeconds !== undefined,
            ),
        ),
        "Native receiver statistics were not mapped to its displayed track",
      );
      const localStats = await a.getVideoStats(
        stream!.getVideoTracks()[0],
      );
      assert(
        localStats.some(
          (batch) =>
            batch.preview &&
            batch.direction === "send" &&
            batch.samples.length,
        ),
        "Native preview sender statistics missing",
      );
      assert(
        localStats.some(
          (batch) =>
            batch.preview &&
            batch.direction === "receive" &&
            batch.samples.length,
        ),
        "Native preview decoder statistics missing",
      );
      assert(
        localStats.some(
          (batch) =>
            !batch.preview &&
            batch.direction === "send" &&
            batch.samples.length,
        ),
        "Native remote sender statistics missing",
      );
      console.log(
        "STREAM_STATISTICS",
        await streamStatisticsCheck(remoteStream, (track) =>
          b.getVideoStats(track),
        ),
      );
    }
    const sharedAudio = sources()
      .find((s) => s.kind === "screen")!
      .stream!.getAudioTracks();
    assert(
      sharedAudio.length === (withAudio ? 1 : 0),
      "Native screen audio did not match the sharing choice",
    );
    if (withAudio) {
      const context = new AudioContext();
      try {
        await context.resume();
        const analyser = context.createAnalyser();
        context
          .createMediaStreamSource(
            new MediaStream(sharedAudio),
          )
          .connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        await until(() => {
          analyser.getFloatTimeDomainData(samples);
          return samples.some(
            (sample) => Math.abs(sample) > 0.005,
          );
        }, "Native audio RTP did not produce audible samples");
      } finally {
        await context.close();
      }
    }
    assert(
      !pa
        .peerConnection!.getSenders()
        .some(
          (sender) =>
            !!sender.track &&
            stream!.getTracks().includes(sender.track),
        ),
      "Preview was re-encoded by ordinary browser sender",
    );
    const multiple = polite && !beforeJoin && withAudio;
    if (multiple) {
      const second = source();
      let secondStream: MediaStream | undefined;
      const secondVideo = document.createElement("video");
      secondVideo.muted = true;
      secondVideo.autoplay = true;
      document.body.append(secondVideo);
      try {
        const firstRemote = sources().find(
          (s) => s.kind === "screen",
        )!;
        const firstId = firstRemote.id;
        secondStream = await createNativeScreenStream(
          second.capture,
          second.share,
          "second",
          undefined,
          options,
        );
        a.setSessionStream(
          pa,
          new MediaStream([
            ...stream.getTracks(),
            ...secondStream.getTracks(),
          ]),
        );
        await until(
          () =>
            sources().filter((s) => s.kind === "screen")
              .length === 2,
          "Second native screen did not arrive",
        );
        const secondRemote = sources().find(
          (s) => s.kind === "screen" && s.id !== firstId,
        )!;
        assert(
          sources().find((s) => s.id === firstId)
            ?.stream === firstRemote.stream,
          "Adding a screen replaced the first media stream",
        );
        assert(
          secondRemote.stream!.getAudioTracks().length ===
            1 &&
            secondRemote.stream!.getAudioTracks()[0] !==
              firstRemote.stream!.getAudioTracks()[0],
          "Concurrent screen audio was not mapped to its own source",
        );
        secondVideo.srcObject = secondRemote.stream;
        await secondVideo.play();
        await until(
          () =>
            secondVideo.getVideoPlaybackQuality()
              .totalVideoFrames > 3,
          "Second native screen did not decode",
        );
        const stats = await b.getVideoStats(
          secondRemote.stream!.getVideoTracks()[0],
        );
        assert(
          stats.some(
            (batch) =>
              batch.direction === "receive" &&
              batch.samples.some(
                (sample) => (sample.frames ?? 0) > 0,
              ),
          ),
          "Second source statistics were not mapped",
        );
        a.setSessionStream(pa, secondStream);
        await until(
          () =>
            sources().filter((s) => s.kind === "screen")
              .length === 1 &&
            sources().some((s) => s.id === secondRemote.id),
          "Stopping the first publication removed the second",
        );
        const frames =
          secondVideo.getVideoPlaybackQuality()
            .totalVideoFrames;
        await until(
          () =>
            secondVideo.getVideoPlaybackQuality()
              .totalVideoFrames >
            frames + 3,
          "Second screen stopped decoding after the first stopped",
        );
        assert(
          second.offers.filter((preview) => !preview)
            .length === 1,
          "Stopping the first screen recreated the second sender",
        );
        a.setSessionStream(pa, stream);
        await until(
          () =>
            sources().some(
              (s) =>
                s.kind === "screen" &&
                s.id !== secondRemote.id,
            ) &&
            !sources().some(
              (s) => s.id === secondRemote.id,
            ),
          "Restoring the first publication did not remove the second",
        );
        await firstFrame();
        await until(
          () => second.peers.size === 1,
          "Removed secondary remote sender leaked",
        );
      } finally {
        secondStream
          ?.getTracks()
          .forEach((track) => track.stop());
        second.close();
        secondVideo.srcObject = null;
        secondVideo.remove();
      }
    }
    a.setSessionStream(pa, null);
    await until(
      () => !sources().some((s) => s.kind === "screen"),
      "Stop did not remove remote screen",
    );
    await until(
      () => synthetic.peers.size === 1,
      "Remote native peer was not released",
    );
    assert(
      stream.getVideoTracks()[0].readyState === "live",
      "Peer stop ended local capture",
    );
    a.setSessionStream(pa, stream);
    await firstFrame();
    assert(
      pa.peerConnection === initial[0] &&
        pb.peerConnection === initial[1],
      "Start/stop required reconnecting the room",
    );
    assert(
      synthetic.offers.filter((preview) => !preview)
        .length === (multiple ? 3 : 2),
      "Did not use native publication for each share",
    );
    return {
      polite,
      beforeJoin,
      withAudio,
      decodedFrames:
        video.getVideoPlaybackQuality().totalVideoFrames,
      restartedWithoutRejoin: true,
      multipleScreens: multiple,
    };
  } finally {
    a.destoryAllSession();
    b.destoryAllSession();
    dispose();
    stream?.getTracks().forEach((track) => track.stop());
    synthetic.close();
    video.srcObject = null;
    video.remove();
  }
}
async function main() {
  const liveSettings = await liveVideoSettingsCheck();
  const scenarios = [];
  for (const polite of [true, false])
    for (const beforeJoin of [false, true])
      scenarios.push(await scenario(polite, beforeJoin));
  scenarios.push(await scenario(true, false, false));
  return {
    ok: true,
    unreachableStun: true,
    liveSettings,
    scenarios,
  };
}
void main()
  .then((report) => {
    window.__SPEED_TEST_REPORT__ = report;
  })
  .catch((error) => {
    window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error);
  });
