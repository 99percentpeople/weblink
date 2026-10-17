// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { videoThumbnail } from "@/libs/utils/video-thumbnail";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";

vi.mock("@/libs/utils/stored-file", () => ({
  fileObjectUrl: vi.fn(() => "blob:video"),
  revokeFileUrl: vi.fn(),
}));
let video: HTMLVideoElement;
let poster: Blob;
beforeEach(() => {
  vi.clearAllMocks();
  video = document.createElement("video");
  vi.spyOn(video, "load").mockImplementation(() => {});
  Object.defineProperties(video, {
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
    duration: { value: 5 },
    readyState: { value: 2 },
  });
  poster = new Blob(["poster"], { type: "image/jpeg" });
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(
    (name, options) => {
      if (name === "video") return video;
      const element = create(name, options);
      if (element instanceof HTMLCanvasElement) {
        vi.spyOn(element, "getContext").mockReturnValue({
          drawImage: vi.fn(),
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(element, "toBlob").mockImplementation(
          (callback) => callback(poster),
        );
      }
      return element;
    },
  );
});
afterEach(() => vi.restoreAllMocks());
const file = () =>
  new File(["video"], "video.webm", { type: "video/webm" });
const ready = async () => {
  await vi.waitFor(() =>
    expect(video.getAttribute("src")).toBe("blob:video"),
  );
  video.dispatchEvent(new Event("loadedmetadata"));
  video.dispatchEvent(new Event("loadeddata"));
};

it("captures a silent frame and releases the decoder and source URL", async () => {
  const result = videoThumbnail(
    file(),
    new AbortController().signal,
  );
  await ready();
  expect(await result).toBe(poster);
  expect(video.muted).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.crossOrigin).toBe("anonymous");
  expect(video.currentTime).toBe(1);
  expect(video.hasAttribute("src")).toBe(false);
  expect(video.load).toHaveBeenCalledOnce();
  expect(revokeFileUrl).toHaveBeenCalledWith("blob:video");
});

it("reuses a poster for the same snapshot without decoding again", async () => {
  const source = file();
  const result = videoThumbnail(
    source,
    new AbortController().signal,
  );
  await ready();
  await result;
  expect(
    await videoThumbnail(
      source,
      new AbortController().signal,
    ),
  ).toBe(poster);
  expect(fileObjectUrl).toHaveBeenCalledOnce();
});

it("releases failed media and allows subsequent files to be decoded", async () => {
  const failed = videoThumbnail(
    file(),
    new AbortController().signal,
  );
  const rejected = expect(failed).rejects.toThrow(
    "Video preview is unavailable",
  );
  await vi.waitFor(() =>
    expect(video.getAttribute("src")).toBe("blob:video"),
  );
  video.dispatchEvent(new Event("error"));
  await rejected;
  expect(video.hasAttribute("src")).toBe(false);
  const next = videoThumbnail(
    file(),
    new AbortController().signal,
  );
  await ready();
  expect(await next).toBe(poster);
});

it("aborts an active decoder and skips cancelled queued files", async () => {
  const active = new AbortController();
  const cancelled = new AbortController();
  const first = videoThumbnail(file(), active.signal);
  const firstRejected = expect(first).rejects.toMatchObject(
    { name: "AbortError" },
  );
  const queued = videoThumbnail(file(), cancelled.signal);
  const queuedRejected = expect(
    queued,
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() =>
    expect(video.getAttribute("src")).toBe("blob:video"),
  );
  cancelled.abort();
  active.abort();
  await Promise.all([firstRejected, queuedRejected]);
  expect(fileObjectUrl).toHaveBeenCalledOnce();
  expect(video.hasAttribute("src")).toBe(false);
  expect(revokeFileUrl).toHaveBeenCalledOnce();
});
