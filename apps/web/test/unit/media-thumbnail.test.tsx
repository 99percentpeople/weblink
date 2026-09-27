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
import { parseMediaHash } from "@/components/conversations/media-hash-route";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(cleanup);
const route = {
  conversationId: "room / %",
  messageId: "photo #1",
};

describe("media thumbnail", () => {
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
