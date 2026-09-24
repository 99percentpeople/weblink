// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { VideoDisplay } from "@/routes/home/components/video-display";

interface ErrorToastOptions {
  id: string;
  action: { label: string; onClick(): void };
}
const notification = vi.hoisted(() => ({
  error: vi.fn(
    (_message: string, options: ErrorToastOptions) =>
      options.id,
  ),
  dismiss: vi.fn(),
}));
vi.mock("solid-sonner", () => ({ toast: notification }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconVolumeUpFilled: () => null,
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: () => <span>Avatar</span>,
}));
vi.mock("@/components/common/spinner", () => ({
  Spinner: () => <span data-testid="loading-spinner" />,
}));
vi.mock("@/libs/hooks/check-volume", () => ({
  createCheckVolume: () => () => false,
}));

class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  stop = vi.fn();
  constructor(readonly id: string) {
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
}
const track = (id: string) =>
  new Track(id) as unknown as MediaStreamTrack;
const stream = (source: MediaStreamTrack) =>
  new Stream([source]) as unknown as MediaStream;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  vi.spyOn(
    HTMLMediaElement.prototype,
    "pause",
  ).mockImplementation(() => {});
  vi.clearAllMocks();
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(source = track("camera")) {
  const [active, setActive] = createSignal(true);
  const [current, setCurrent] = createSignal<MediaStream>(
    stream(source),
  );
  const view = render(() => (
    <VideoDisplay
      stream={current()}
      name="Alice"
      muted
      playbackActive={active()}
    />
  ));
  return {
    ...view,
    setCurrent,
    setActive,
    video: view.container.querySelector("video")!,
    source,
  };
}

describe("VideoDisplay playback error notifications", () => {
  it("prepares muted inline video before the first playback request", () => {
    play.mockImplementation(function (
      this: HTMLVideoElement,
    ) {
      expect(this.muted).toBe(true);
      expect(this.playsInline).toBe(true);
      expect(this.srcObject).not.toBeNull();
      return Promise.resolve();
    });
    setup();
    expect(play).toHaveBeenCalledOnce();
  });

  it("recovers an aborted first play on metadata and later unmute without rebinding the borrowed source", async () => {
    play.mockRejectedValueOnce(
      new DOMException(
        "Interrupted while mounting",
        "AbortError",
      ),
    );
    const { video, source, setActive } = setup();
    const attached = video.srcObject;
    await flush();
    fireEvent.loadedMetadata(video);
    expect(play).toHaveBeenCalledTimes(2);
    // Deduplicate readiness signals while this play request is pending.
    fireEvent.canPlay(video);
    source.dispatchEvent(new Event("unmute"));
    expect(play).toHaveBeenCalledTimes(2);
    await flush();
    source.dispatchEvent(new Event("unmute"));
    expect(play).toHaveBeenCalledTimes(3);
    await flush();
    setActive(false);
    source.dispatchEvent(new Event("unmute"));
    expect(play).toHaveBeenCalledTimes(3);
    setActive(true);
    expect(play).toHaveBeenCalledTimes(4);
    expect(video.srcObject).toBe(attached);
    expect(source.stop).not.toHaveBeenCalled();
    expect(notification.error).not.toHaveBeenCalled();
  });

  it("shows one retryable toast instead of a persistent error overlay and retains normal loading indicators", () => {
    const { video } = setup();
    expect(
      screen.getByTestId("loading-spinner"),
    ).toBeTruthy();
    fireEvent.error(video);
    fireEvent.error(video);
    expect(notification.error).toHaveBeenCalledOnce();
    expect(notification.error).toHaveBeenCalledWith(
      "Alice: video.loading_state.error",
      {
        id: "video-playback-camera",
        action: {
          label: "video.loading_state.retry",
          onClick: expect.any(Function),
        },
      },
    );
    expect(
      screen.queryByText("video.loading_state.error"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "video.loading_state.retry",
      }),
    ).toBeNull();
    expect(
      screen.queryByTestId("loading-spinner"),
    ).toBeNull();
    fireEvent.waiting(video);
    expect(
      screen.getByText("video.loading_state.waiting"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("loading-spinner"),
    ).toBeTruthy();
    fireEvent.stalled(video);
    expect(
      screen.getByText("video.loading_state.stalled"),
    ).toBeTruthy();
    expect(notification.error).toHaveBeenCalledOnce();
  });

  it("retries the same borrowed track from the toast and allows a later failure after recovery", () => {
    const { video, source } = setup();
    fireEvent.error(video);
    const retry =
      notification.error.mock.calls[0][1].action.onClick;
    const calls = play.mock.calls.length;
    retry();
    expect(play).toHaveBeenCalledTimes(calls + 1);
    expect(
      (video.srcObject as MediaStream).getTracks(),
    ).toEqual([source]);
    expect(source.stop).not.toHaveBeenCalled();
    expect(
      screen.getByText("video.loading_state.initial"),
    ).toBeTruthy();
    fireEvent.error(video);
    expect(notification.error).toHaveBeenCalledTimes(2);
    fireEvent.playing(video);
    expect(notification.dismiss).toHaveBeenCalledWith(
      "video-playback-camera",
    );
    expect(
      screen.queryByTestId("loading-spinner"),
    ).toBeNull();
    fireEvent.error(video);
    expect(notification.error).toHaveBeenCalledTimes(3);
  });

  it("reports rejected playback once even if the video also emits error, while ignoring expected AbortError", async () => {
    play.mockRejectedValueOnce(
      new DOMException(
        "User gesture required",
        "NotAllowedError",
      ),
    );
    const first = setup();
    await flush();
    expect(notification.error).toHaveBeenCalledOnce();
    expect(notification.error).toHaveBeenCalledWith(
      "Alice: video.loading_state.autoplay_blocked",
      expect.objectContaining({
        duration: Infinity,
        action: {
          label: "video.loading_state.play",
          onClick: expect.any(Function),
        },
      }),
    );
    fireEvent.error(first.video);
    expect(notification.error).toHaveBeenCalledOnce();
    notification.error.mock.calls[0][1].action.onClick();
    expect(play).toHaveBeenCalledTimes(2);
    expect(first.source.stop).not.toHaveBeenCalled();
    first.unmount();
    notification.error.mockClear();
    play.mockRejectedValueOnce(
      new DOMException("Source changed", "AbortError"),
    );
    setup(track("screen"));
    await flush();
    expect(notification.error).not.toHaveBeenCalled();
  });

  it("ignores old source failures and retry actions after switching sources or unmounting", async () => {
    let reject!: (error: Error) => void;
    play.mockReturnValueOnce(
      new Promise<void>((_resolve, onReject) => {
        reject = onReject;
      }),
    );
    const { video, setCurrent, unmount } = setup();
    fireEvent.error(video);
    const oldRetry =
      notification.error.mock.calls[0][1].action.onClick;
    const next = track("screen");
    setCurrent(stream(next));
    const calls = play.mock.calls.length;
    oldRetry();
    expect(play).toHaveBeenCalledTimes(calls);
    reject(new Error("Old camera failed"));
    await flush();
    expect(notification.error).toHaveBeenCalledOnce();
    expect(notification.dismiss).toHaveBeenCalledWith(
      "video-playback-camera",
    );
    fireEvent.error(video);
    expect(notification.error.mock.calls[1][1].id).toBe(
      "video-playback-screen",
    );
    const currentRetry =
      notification.error.mock.calls[1][1].action.onClick;
    unmount();
    expect(video.srcObject).toBeNull();
    expect(
      HTMLMediaElement.prototype.pause,
    ).toHaveBeenCalled();
    currentRetry();
    expect(play).toHaveBeenCalledTimes(calls);
    expect(notification.dismiss).toHaveBeenCalledWith(
      "video-playback-screen",
    );
    expect(next.stop).not.toHaveBeenCalled();
  });
});
