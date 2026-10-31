import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { notifyPresentationLayout } from "@weblink/platform";
import { createNativePresentation } from "../../src/presentation";

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
async function play(video: HTMLVideoElement) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      video.play(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Placeholder never became playable",
              ),
            ),
          3000,
        );
      }),
    ]);
    assert(
      video.videoWidth > 0,
      "Placeholder lost source dimensions",
    );
  } finally {
    clearTimeout(timer!);
  }
}

/** Real canvas capture, media attachment, observers and WAAPI; only native IPC
 * is mocked. Check scheduling/lifecycle, without asserting layout geometry. */
export async function idlePresentation() {
  let events!: Channel<{
    type: string;
    width: number;
    height: number;
  }>;
  let layouts = 0;
  const errors: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "presentation_open")
      events = (args as { events: typeof events }).events;
    if (command === "presentation_stats")
      return { presentedFrames: 1 };
    if (command === "presentation_layout") layouts++;
  });
  const presentation = createNativePresentation();
  const surface = presentation.create(
    "receiver",
    false,
    () => {},
    () => {},
    (error) => errors.push(error),
  );
  const tile = document.createElement("div");
  tile.style.cssText =
    "width:320px;height:180px;overflow:hidden";
  document.body.append(tile);
  let unbind: (() => void) | undefined;
  let measurements = 0;
  const attach = () => {
    const video = document.createElement("video");
    video.muted = true;
    video.style.cssText =
      "width:100%;height:100%;object-fit:contain";
    const measure = video.getBoundingClientRect.bind(video);
    video.getBoundingClientRect = () => {
      measurements++;
      return measure();
    };
    tile.replaceChildren(video);
    unbind = presentation.bind(
      surface.stream.getVideoTracks()[0],
      video,
    );
    video.srcObject = surface.stream;
    return video;
  };
  try {
    await surface.open();
    events.onmessage({
      type: "surface",
      width: 640,
      height: 360,
    });
    // First frame predates attachment, as in the production receive path.
    await sleep(100);
    const first = attach();
    await play(first);
    await sleep(300);
    const before = measurements;
    const frames =
      first.getVideoPlaybackQuality().totalVideoFrames;
    const beforeLayouts = layouts;
    await sleep(1300);
    const idleReads = measurements - before;
    const idleFrames =
      first.getVideoPlaybackQuality().totalVideoFrames -
      frames;
    assert(
      idleReads === 0,
      `Static layout still measured ${idleReads} times`,
    );
    assert(
      idleFrames === 0,
      `Static placeholder still delivered ${idleFrames} frames`,
    );
    assert(
      layouts === beforeLayouts,
      "Idle native layouts still sent",
    );
    const animation = tile.animate(
      [
        { transform: "translateX(0px)" },
        { transform: "translateX(40px)" },
      ],
      { duration: 250 },
    );
    notifyPresentationLayout(tile);
    await animation.finished;
    await sleep(150);
    const animatedReads = measurements - before;
    assert(
      animatedReads > 2,
      "WAAPI did not wake and follow native layout",
    );
    const settled = measurements;
    await sleep(300);
    assert(
      measurements === settled,
      "Animation did not return to idle",
    );
    first.pause();
    await play(first);
    unbind?.();
    const second = attach();
    await play(second);
    const resized = new Promise<void>((resolve) =>
      second.addEventListener("resize", () => resolve(), {
        once: true,
      }),
    );
    events.onmessage({
      type: "surface",
      width: 800,
      height: 600,
    });
    await Promise.race([resized, sleep(1500)]);
    assert(
      second.videoWidth === 800 &&
        second.videoHeight === 600,
      "Reattached placeholder missed source resize",
    );
    assert(
      !errors.length,
      `Native presentation failed: ${errors}`,
    );
    return {
      idleReads,
      idleFrames,
      animatedReads,
      reattached: true,
      resized: true,
    };
  } finally {
    unbind?.();
    surface.close();
    tile.remove();
    await sleep(0);
    clearMocks();
  }
}
