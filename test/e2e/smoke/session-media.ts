import { PeerSessionMediaController } from "../../../src/libs/domain/session-media";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value)
    throw new Error(`RTC media smoke: ${message}`);
}
async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() > deadline)
      throw new Error(
        `RTC media smoke timed out: ${label}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
function videoSource(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "white";
    context.fillText(String(frame++), 8, 30);
  };
  draw();
  const stream = canvas.captureStream(10);
  const interval = setInterval(draw, 75);
  return {
    track: stream.getVideoTracks()[0],
    close() {
      clearInterval(interval);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
async function received(
  receiver: RTCRtpReceiver,
): Promise<number> {
  let bytes = 0;
  (await receiver.getStats()).forEach((report) => {
    if (report.type === "inbound-rtp")
      bytes += report.bytesReceived ?? 0;
  });
  return bytes;
}

/** Actual RTP media and renegotiation; no camera/microphone permission needed. */
export async function runSessionMediaSmoke() {
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({
    iceServers: [],
  });
  const lifetime = new AbortController();
  const camera = videoSource("#166534"),
    screen = videoSource("#1d4ed8");
  const sources = [camera, screen];
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  const microphone = destination.stream.getAudioTracks()[0];
  oscillator.connect(destination);
  oscillator.start();
  const screenDestination =
    audio.createMediaStreamDestination();
  const screenOscillator = audio.createOscillator();
  screenOscillator.frequency.value = 880;
  screenOscillator.connect(screenDestination);
  screenOscillator.start();
  const screenAudio =
    screenDestination.stream.getAudioTracks()[0];
  let remote: MediaStream | null = null;
  let renegotiationsRequested = 0;
  sender.addEventListener(
    "negotiationneeded",
    () => {
      renegotiationsRequested++;
    },
    { signal: lifetime.signal },
  );
  const options = {
    getCodecOptions: () => ({
      preferredVideoCodec: null,
      preferredAudioCodec: null,
    }),
    notifyStreamState: () => {},
  };
  const sending = new PeerSessionMediaController({
    ...options,
    targetClientId: () => "receiver",
    getPeerConnection: () => sender,
    onRemoteStreamChange: () => {},
  });
  const receiving = new PeerSessionMediaController({
    ...options,
    targetClientId: () => "sender",
    getPeerConnection: () => receiver,
    onRemoteStreamChange: (stream) => {
      remote = stream;
    },
  });
  const negotiate = async () => {
    await sender.setLocalDescription(
      await sender.createOffer(),
    );
    await waitUntil(
      () => sender.iceGatheringState === "complete",
      "sender ICE gathering",
    );
    await receiver.setRemoteDescription(
      sender.localDescription!,
    );
    await receiver.setLocalDescription(
      await receiver.createAnswer(),
    );
    await waitUntil(
      () => receiver.iceGatheringState === "complete",
      "receiver ICE gathering",
    );
    await sender.setRemoteDescription(
      receiver.localDescription!,
    );
  };
  const remoteReceiver = (track: MediaStreamTrack) => {
    const mid = sender
      .getTransceivers()
      .find((item) => item.sender.track === track)?.mid;
    assert(
      mid !== undefined && mid !== null,
      "sender has no negotiated media section",
    );
    const result = receiver
      .getTransceivers()
      .find((item) => item.mid === mid)?.receiver;
    assert(
      result,
      "receiver has no corresponding media section",
    );
    return result;
  };
  const trackCount = (kind: "video" | "audio") =>
    remote
      ?.getTracks()
      .filter((track) => track.kind === kind).length ?? 0;
  try {
    // The browser runner enables autoplay to let this generated audio source run.
    void audio.resume();
    await waitUntil(
      () => audio.state === "running",
      "AudioContext running (requires headless autoplay policy)",
    );
    sending.setStream(
      new MediaStream([
        camera.track,
        screen.track,
        microphone,
        screenAudio,
      ]),
    );
    sending.bindConnection(sender, lifetime.signal);
    receiving.bindConnection(receiver, lifetime.signal);
    await negotiate();
    await waitUntil(
      () =>
        trackCount("video") === 2 &&
        trackCount("audio") === 2,
      "two videos plus microphone and shared audio",
    );
    const cameraReceiver = remoteReceiver(camera.track);
    const screenReceiver = remoteReceiver(screen.track);
    const microphoneReceiver = remoteReceiver(microphone);
    const screenAudioReceiver = remoteReceiver(screenAudio);
    await waitUntil(
      async () =>
        (await received(cameraReceiver)) > 0 &&
        (await received(screenReceiver)) > 0 &&
        (await received(microphoneReceiver)) > 0 &&
        (await received(screenAudioReceiver)) > 0,
      "RTP packets for both videos and both audio sources",
    );

    sending.setStream(
      new MediaStream([
        screen.track,
        microphone,
        screenAudio,
      ]),
    );
    assert(
      camera.track.readyState === "live",
      "peer stopped its borrowed camera capture",
    );
    camera.close();
    await negotiate();
    await waitUntil(
      () =>
        trackCount("video") === 1 &&
        trackCount("audio") === 2,
      "camera removed independently",
    );
    assert(
      remote!.getVideoTracks()[0] === screenReceiver.track,
      "removing camera replaced the screen track",
    );
    const screenBefore = await received(screenReceiver),
      audioBefore = await received(microphoneReceiver),
      screenAudioBefore = await received(
        screenAudioReceiver,
      );
    await waitUntil(
      async () =>
        (await received(screenReceiver)) > screenBefore &&
        (await received(microphoneReceiver)) >
          audioBefore &&
        (await received(screenAudioReceiver)) >
          screenAudioBefore,
      "screen, shared audio and microphone continue after camera removal",
    );

    const replacement = videoSource("#7e22ce");
    sources.push(replacement);
    sending.setStream(
      new MediaStream([
        replacement.track,
        screen.track,
        microphone,
        screenAudio,
      ]),
    );
    await negotiate();
    await waitUntil(
      () =>
        trackCount("video") === 2 &&
        trackCount("audio") === 2,
      "camera restored alongside screen",
    );
    const replacementReceiver = remoteReceiver(
      replacement.track,
    );
    const restoredCameraBefore = await received(
      replacementReceiver,
    );
    await waitUntil(
      async () =>
        (await received(replacementReceiver)) >
        restoredCameraBefore,
      "restored camera RTP",
    );

    sending.setStream(
      new MediaStream([replacement.track, microphone]),
    );
    screen.close();
    screenAudio.stop();
    await negotiate();
    await waitUntil(
      () =>
        trackCount("video") === 1 &&
        trackCount("audio") === 1,
      "screen removed independently",
    );
    assert(
      remote!.getVideoTracks()[0] ===
        replacementReceiver.track &&
        remote!.getAudioTracks()[0] ===
          microphoneReceiver.track,
      "removing screen and its audio replaced the camera or microphone track",
    );
    const cameraBefore = await received(
        replacementReceiver,
      ),
      audioAfterScreen = await received(microphoneReceiver);
    await waitUntil(
      async () =>
        (await received(replacementReceiver)) >
          cameraBefore &&
        (await received(microphoneReceiver)) >
          audioAfterScreen,
      "camera and microphone continue after screen removal",
    );
    sending.setStream(null);
    await negotiate();
    await waitUntil(
      () => remote === null,
      "all remote sources removed",
    );
    assert(
      replacement.track.readyState === "live" &&
        microphone.readyState === "live",
      "clearing one peer stopped shared captures",
    );
    return {
      transport: "real Chromium RTP over RTCPeerConnection",
      initialVideoTracks: 2,
      initialAudioTracks: 2,
      allFourSourcesReceivedRtp: true,
      cameraRemovalPreservedScreenAndAudio: true,
      screenRemovalPreservedCameraAndAudio: true,
      replacementCameraReceivedRtp: true,
      receiverTrackReused:
        replacementReceiver.track === cameraReceiver.track,
      emptyRemoteStreamCleared: true,
      borrowedCapturePreserved: true,
      renegotiationsRequested,
    };
  } finally {
    lifetime.abort();
    sending.dispose();
    receiving.dispose();
    sender.close();
    receiver.close();
    for (const source of sources) source.close();
    oscillator.stop();
    screenOscillator.stop();
    screenAudio.stop();
    microphone.stop();
    await audio.close();
  }
}
