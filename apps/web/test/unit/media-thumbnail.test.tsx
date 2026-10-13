// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { MediaThumbnail } from "@/components/conversations/media-thumbnail";
import { LocalFileMedia } from "@/components/conversations/local-file-media";
import { parseMediaHash } from "@/components/conversations/media-hash-route";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const route = {
  conversationId: "room / %",
  messageId: "photo #1",
};

describe("media thumbnail", () => {
  it.each([
    [
      "holiday.png",
      "image/png",
      undefined,
      "image/png",
      "holiday.png",
    ],
    [
      "旅行照片 01.jpg",
      "",
      "image/jpeg",
      "image/jpeg",
      "旅行照片 01.jpg",
    ],
    [
      "snapshot:01.webp",
      "image/webp",
      undefined,
      "image/webp",
      "snapshot_01.webp",
    ],
  ])(
    "drags %s with its filename instead of the blob ID",
    (name, type, mimeType, expectedType, expectedName) => {
      const src = "blob:https://webl.ink/opaque-file-id";
      vi.stubGlobal(
        "URL",
        class extends URL {
          static createObjectURL = vi.fn(() => src);
          static revokeObjectURL = vi.fn();
        },
      );
      const file = new File(["image bytes"], name, {
        type,
      });
      render(() => (
        <LocalFileMedia
          file={file}
          mimeType={mimeType}
          route={route}
        />
      ));
      const dataTransfer = {
        effectAllowed: "uninitialized",
        setData: vi.fn(),
      };
      expect(
        fireEvent.dragStart(screen.getByRole("img"), {
          dataTransfer,
        }),
      ).toBe(true);
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "DownloadURL",
        `${expectedType}:${expectedName}:${src}`,
      );
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        "text/uri-list",
        src,
      );
      expect(dataTransfer.effectAllowed).toBe("copy");
      // Dragging exports the file, while clicking still navigates to its preview.
      expect(
        parseMediaHash(
          screen.getByRole("link").getAttribute("href")!,
        ),
      ).toEqual(route);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    },
  );

  it.each([
    [240, 800, "auto", "100%"],
    [800, 240, "100%", "auto"],
    [640, 480, "auto", "100%"],
  ])(
    "fits %sx%s media without treating letterboxing as image bounds",
    (width, height, cssWidth, cssHeight) => {
      render(() => (
        <MediaThumbnail
          src="blob:photo"
          name="photo"
          kind="image"
          route={route}
        />
      ));
      const link = screen.getByRole("link");
      expect(
        parseMediaHash(link.getAttribute("href")!),
      ).toEqual(route);
      expect(link).toHaveAttribute(
        "data-media-ready",
        "false",
      );
      expect(link).not.toHaveAttribute("data-pswp-width");
      const image = screen.getByRole("img");
      Object.defineProperties(image, {
        naturalWidth: { value: width },
        naturalHeight: { value: height },
      });
      fireEvent.load(image);
      expect(link).toHaveAttribute(
        "data-media-ready",
        "true",
      );
      expect(link).toHaveAttribute(
        "data-pswp-width",
        String(width),
      );
      expect(link).toHaveAttribute(
        "data-pswp-height",
        String(height),
      );
      expect(image).toHaveStyle({
        width: cssWidth,
        height: cssHeight,
      });
      expect(link).toHaveClass("aspect-video");
      expect(link).toHaveAttribute(
        "data-pswp-src",
        "blob:photo",
      );
    },
  );
  it("drops old dimensions when the media source changes", () => {
    const [src, setSrc] = createSignal("blob:first");
    render(() => (
      <MediaThumbnail
        src={src()}
        name="photo"
        kind="image"
        route={route}
      />
    ));
    const image = screen.getByRole("img");
    Object.defineProperties(image, {
      naturalWidth: { value: 100 },
      naturalHeight: { value: 200 },
    });
    fireEvent.load(image);
    setSrc("blob:second");
    expect(screen.getByRole("link")).toHaveAttribute(
      "data-media-ready",
      "false",
    );
    expect(screen.getByRole("link")).not.toHaveAttribute(
      "data-pswp-width",
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "blob:second",
    );
  });
});
