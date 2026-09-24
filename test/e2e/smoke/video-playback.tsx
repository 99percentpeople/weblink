import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { VideoDisplay } from "@/routes/home/components/video-display";
import { PeerSessionMediaController } from "@/libs/domain/session-media";
import "@/global.css";

declare global {
  interface Window {
    __SPEED_TEST_REPORT__?: unknown;
    __SPEED_TEST_ERROR__?: string;
  }
}

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
async function until(
  check: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
const paint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve()),
    ),
  );

async function main() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d")!;
  const draw = () => {
    context.fillStyle = "#2060e0";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "white";
    context.fillText(String(performance.now()), 20, 20);
  };
  draw();
  const stream = canvas.captureStream(15);
  const timer = setInterval(draw, 60);
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({
    iceServers: [],
  });
  const lifetime = new AbortController();
  let remote: MediaStream | null = null;
  const defaults = {
    getCodecOptions: () => ({
      preferredVideoCodec: null,
      preferredAudioCodec: null,
    }),
    notifyStreamState: () => {},
  };
  const sending = new PeerSessionMediaController({
    ...defaults,
    targetClientId: () => "receiver",
    getPeerConnection: () => sender,
    onRemoteStreamChange() {},
  });
  const receiving = new PeerSessionMediaController({
    ...defaults,
    targetClientId: () => "sender",
    getPeerConnection: () => receiver,
    onRemoteStreamChange: (value) => {
      remote = value;
    },
  });
  const host = document.createElement("div");
  host.style.cssText =
    "position:relative;width:360px;height:202px";
  document.body.append(host);
  const originalPlay = HTMLMediaElement.prototype.play;
  let plays = 0;
  let dispose = () => {};
  try {
    sending.setStream(stream);
    sending.bindConnection(sender, lifetime.signal);
    receiving.bindConnection(receiver, lifetime.signal);
    await sender.setLocalDescription(
      await sender.createOffer(),
    );
    await until(
      () => sender.iceGatheringState === "complete",
      "sender ICE ready",
    );
    await receiver.setRemoteDescription(
      sender.localDescription!,
    );
    await receiver.setLocalDescription(
      await receiver.createAnswer(),
    );
    await until(
      () => receiver.iceGatheringState === "complete",
      "receiver ICE ready",
    );
    await sender.setRemoteDescription(
      receiver.localDescription!,
    );
    await until(
      () => Boolean(remote?.getVideoTracks().length),
      "received video track",
    );
    const track = remote!.getVideoTracks()[0];
    HTMLMediaElement.prototype.play = function () {
      plays++;
      // Safari can interrupt a play request while the received track initializes.
      if (plays === 1)
        return Promise.reject(
          new DOMException(
            "Initial mount interrupted",
            "AbortError",
          ),
        );
      return originalPlay.call(this);
    };
    let setActive: (active: boolean) => void = () => {};
    dispose = render(() => {
      const [active, set] = createSignal(false);
      setActive = set;
      return (
        <VideoDisplay
          class="size-full"
          name="Remote screen"
          stream={remote}
          muted
          playbackActive={active()}
        />
      );
    }, host);
    const video = host.querySelector("video")!;
    await paint();
    assert(
      !video.srcObject && plays === 0,
      "hidden stage must not attach or play the stream",
    );
    setActive(true);
    await until(
      () =>
        video.videoWidth > 0 &&
        video.readyState >= 2 &&
        !video.paused,
      "visible video recovers interrupted first playback",
    );
    const attached = video.srcObject;
    assert(
      (attached as MediaStream).getVideoTracks()[0] ===
        track,
      "renderer uses the borrowed received track",
    );
    const sample = document.createElement("canvas");
    sample.width = sample.height = 1;
    const sampleContext = sample.getContext("2d")!;
    await until(() => {
      sampleContext.drawImage(
        video,
        100,
        100,
        1,
        1,
        0,
        0,
        1,
        1,
      );
      const [r, g, b] = sampleContext.getImageData(
        0,
        0,
        1,
        1,
      ).data;
      return b > 150 && g > r && b > g;
    }, "received video contains decoded source pixels");

    setActive(false);
    await paint();
    assert(
      video.srcObject === attached,
      "hiding the page preserves a PiP-capable source",
    );
    video.pause();
    setActive(true);
    await until(
      () => !video.paused,
      "returning to stage resumes paused video",
    );
    const beforeReveal = plays;
    setActive(false);
    setActive(true);
    await until(
      () => plays > beforeReveal,
      "reveal refreshes inline playback even when paused is false",
    );
    await paint();
    const beforeExit = plays;
    // Exercise the event path; this is not a native iOS PiP/device test.
    video.dispatchEvent(
      new Event("webkitpresentationmodechanged"),
    );
    await until(
      () => plays > beforeExit,
      "native presentation return refreshes inline video",
    );
    assert(
      video.srcObject === attached,
      "recovery must not replace the source",
    );
    const report = await receiver.getStats();
    let framesDecoded = 0;
    report.forEach((item) => {
      if (
        item.type === "inbound-rtp" &&
        item.kind === "video"
      )
        framesDecoded += item.framesDecoded ?? 0;
    });
    assert(
      framesDecoded > 0,
      "real received RTP frames were decoded",
    );
    dispose();
    dispose = () => {};
    assert(
      track.readyState === "live",
      "renderer cleanup must not stop received tracks",
    );
    return {
      ok: true,
      realRtp: true,
      framesDecoded,
      hiddenSourceDeferred: true,
      initialAbortRecovered: true,
      visibilityRecovered: true,
      presentationEventRecovered: true,
      sameBorrowedTrack: true,
    };
  } finally {
    dispose();
    HTMLMediaElement.prototype.play = originalPlay;
    lifetime.abort();
    sending.dispose();
    receiving.dispose();
    sender.close();
    receiver.close();
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    host.remove();
  }
}
void main()
  .then((report) => {
    window.__SPEED_TEST_REPORT__ = report;
  })
  .catch((error) => {
    window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error);
  });
