import { createLiveVideoSettings } from "@/libs/application/live-video-settings";
import { getDefaultAppOptions } from "@/libs/state/app-options";

/** A real capture track and RTP receiver must survive down/up changes. */
export async function liveVideoSettingsCheck() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, frameRate: 30 },
  });
  const track = stream.getVideoTracks()[0];
  const maximumFrameRate =
    track.getCapabilities().frameRate?.max ?? 30;
  const sending = new RTCPeerConnection();
  const receiving = new RTCPeerConnection();
  const failures: unknown[] = [];
  let observed: unknown;
  const settings = createLiveVideoSettings({
    publication: () => undefined,
    error: (error) => failures.push(error),
  });
  const wait = async (check: () => Promise<boolean>) => {
    const deadline = performance.now() + 10000;
    while (!(await check())) {
      if (failures.length) throw failures[0];
      if (performance.now() > deadline)
        throw new Error(
          `Live browser settings did not reach RTP receiver: ${JSON.stringify(observed)}`,
        );
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
    }
  };
  const inbound = async () =>
    [...(await receiving.getStats()).values()].find(
      (stat) =>
        stat.type === "inbound-rtp" &&
        stat.kind === "video",
    );
  let remote: MediaStreamTrack | undefined;
  receiving.ontrack = (event) => {
    remote = event.track;
  };
  try {
    const sender = sending.addTrack(track, stream);
    // Gather once so this probe has no candidate/description timing races.
    await sending.setLocalDescription(
      await sending.createOffer(),
    );
    await wait(
      async () => sending.iceGatheringState === "complete",
    );
    await receiving.setRemoteDescription(
      sending.localDescription!,
    );
    await receiving.setLocalDescription(
      await receiving.createAnswer(),
    );
    await wait(
      async () =>
        receiving.iceGatheringState === "complete",
    );
    await sending.setRemoteDescription(
      receiving.localDescription!,
    );
    const parameters = sender.getParameters();
    parameters.degradationPreference =
      "maintain-resolution";
    parameters.encodings[0].maxBitrate = 4_000_000;
    await sender.setParameters(parameters);
    await wait(
      async () => (await inbound())?.framesDecoded > 3,
    );
    const remoteId = remote!.id;
    const report = [];
    for (const [resolution, fps, width, height] of [
      ["480p", 15, 854, 480],
      ["720p", 30, 1280, 720],
    ] as const) {
      const before = await inbound();
      settings.sync(stream, {
        ...getDefaultAppOptions(),
        videoResolution: resolution,
        videoFrameRate: fps,
      });
      await wait(async () => {
        const local = track.getSettings(),
          received = await inbound();
        observed = { local, received };
        return (
          local.frameRate ===
            Math.min(fps, maximumFrameRate) &&
          local.height === height &&
          received.framesDecoded >
            before.framesDecoded + 3 &&
          received.frameHeight === height &&
          received.frameWidth <= width
        );
      });
      if (
        remote!.id !== remoteId ||
        track.readyState !== "live"
      )
        throw new Error(
          "Settings recreated browser capture or receiver",
        );
      report.push({
        resolution,
        fps,
        captureFps: track.getSettings().frameRate,
        decoded: (await inbound()).framesDecoded,
      });
    }
    if (failures.length) throw failures[0];
    return {
      sameCaptureAndReceiver: true,
      updates: report,
    };
  } finally {
    settings.dispose();
    sending.close();
    receiving.close();
    stream.getTracks().forEach((track) => track.stop());
  }
}
