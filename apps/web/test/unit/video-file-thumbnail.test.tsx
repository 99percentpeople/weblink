// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import { VideoFileThumbnail } from "@/components/files/video-file-thumbnail";
import { videoThumbnail } from "@/libs/utils/video-thumbnail";

vi.mock("@/libs/utils/video-thumbnail", () => ({
  videoThumbnail: vi.fn(),
}));
let visibility: (visible: boolean) => void;
const disconnect = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = (isIntersecting) =>
          callback(
            [
              {
                isIntersecting,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:poster");
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("waits until visible, shows the poster, and releases it when unmounted", async () => {
  vi.mocked(videoThumbnail).mockResolvedValue(
    new Blob(["poster"]),
  );
  const view = render(() => (
    <VideoFileThumbnail file={new File([], "clip.webm")} />
  ));
  expect(videoThumbnail).not.toHaveBeenCalled();
  visibility(true);
  await waitFor(() =>
    expect(
      view.container.querySelector("img"),
    ).toHaveAttribute("src", "blob:poster"),
  );
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(
    "blob:poster",
  );
  expect(disconnect).toHaveBeenCalledOnce();
});

it("cancels when scrolled out and ignores a late poster", async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(videoThumbnail).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(() => (
    <VideoFileThumbnail file={new File([], "clip.webm")} />
  ));
  visibility(true);
  const signal = vi.mocked(videoThumbnail).mock.calls[0][1];
  visibility(false);
  expect(signal.aborted).toBe(true);
  finish(new Blob(["late"]));
  await Promise.resolve();
  expect(view.container.querySelector("img")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("keeps the fallback icon when a video cannot be decoded", async () => {
  vi.mocked(videoThumbnail).mockRejectedValue(
    new Error("Unsupported codec"),
  );
  const view = render(() => (
    <VideoFileThumbnail file={new File([], "clip.webm")} />
  ));
  visibility(true);
  await Promise.resolve();
  expect(
    view.container.querySelector("svg"),
  ).not.toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
});
