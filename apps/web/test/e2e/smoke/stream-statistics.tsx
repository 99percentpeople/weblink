import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { VideoStatsBatch } from "@/libs/domain/video-stats";
import { VideoDisplay } from "@/routes/home/components/video-display";
import { VideoStatisticsOverlay } from "@/routes/home/components/video-statistics-overlay";
import { t } from "@/i18n";

/** Real RTP metrics plus overlay lifetime; no geometry/screenshot assertions. */
export async function streamStatisticsCheck(
  stream: MediaStream,
  read: (
    track: MediaStreamTrack,
  ) => Promise<VideoStatsBatch[]>,
) {
  const host = document.createElement("div");
  document.body.append(host);
  let toggle!: (shown: boolean) => void;
  let calls = 0;
  let disposed = false;
  const dispose = render(() => {
    const [shown, setShown] = createSignal(false);
    toggle = setShown;
    return (
      <VideoDisplay
        stream={stream}
        name="Statistics receiver"
        muted
      >
        <Show when={shown()}>
          <VideoStatisticsOverlay
            read={async (track) => {
              calls++;
              return read(track);
            }}
          />
        </Show>
      </VideoDisplay>
    );
  }, host);
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 10000;
    while (!check()) {
      if (performance.now() > deadline)
        throw new Error(
          "Statistics overlay did not receive live RTP metrics",
        );
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
    }
  };
  try {
    await until(() => !!host.querySelector("video"));
    const video = host.querySelector("video")!;
    if (calls !== 0)
      throw new Error("Disabled overlay polled statistics");
    toggle(true);
    await until(() => {
      const text =
        host.querySelector("[data-stream-statistics]")
          ?.textContent ?? "";
      return (
        /VP8|H264|VP9|AV1/i.test(text) &&
        /[1-9][\d.]* FPS/.test(text) &&
        text.includes(t("video.statistics.display")) &&
        /[\d.]+ kbps|[\d.]+ Mbps/.test(text) &&
        /[\d.]+ ms/.test(text)
      );
    });
    if (host.querySelector("video") !== video)
      throw new Error(
        "Showing statistics replaced the video element",
      );
    const text = host.querySelector(
      "[data-stream-statistics]",
    )!.textContent;
    toggle(false);
    const stoppedAt = calls;
    await new Promise((resolve) =>
      setTimeout(resolve, 1300),
    );
    if (
      calls !== stoppedAt ||
      host.querySelector("[data-stream-statistics]")
    )
      throw new Error("Hidden overlay kept sampling");
    if (
      host.querySelector("video") !== video ||
      stream.getVideoTracks()[0].readyState !== "live"
    )
      throw new Error(
        "Overlay toggle interrupted playback/capture",
      );
    dispose();
    disposed = true;
    if (stream.getVideoTracks()[0].readyState !== "live")
      throw new Error(
        "Overlay disposal stopped a borrowed track",
      );
    return {
      liveStatistics: text,
      stoppedPolling: true,
      keptVideo: true,
    };
  } finally {
    if (!disposed) dispose();
    host.remove();
  }
}
