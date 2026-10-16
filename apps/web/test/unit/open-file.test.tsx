// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import {
  RangeFile,
  type StoredFile,
} from "@weblink/platform";
import {
  createPreviewDialog,
  createSendItemPreviewDialog,
} from "@/components/dialogs/preview-dialog";
import { LocalFileMedia } from "@/components/conversations/local-file-media";
import { parseMediaHash } from "@/components/conversations/media-hash-route";
import { sourceForFileUrl } from "@/libs/utils/stored-file";

const fixture = vi.hoisted(() => ({
  platform: {
    openFile: undefined as
      | ((file: StoredFile) => Promise<void>)
      | undefined,
  },
  dialog: vi.fn(),
  openDialog: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: fixture.platform,
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));
vi.mock("@/components/dialogs/dialog", () => ({
  createDialog: fixture.dialog,
}));
vi.mock("@/components/icons", () => ({
  IconDownload: () => null,
  IconShare: () => null,
}));
const disposers: (() => void)[] = [];
const preview = () =>
  createRoot((dispose) => {
    disposers.push(dispose);
    return createPreviewDialog();
  });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.platform.openFile = undefined;
  fixture.openDialog.mockResolvedValue({ result: true });
  fixture.dialog.mockReturnValue({
    open: fixture.openDialog,
    close: vi.fn(),
    submit: vi.fn(),
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens desktop files through the system without creating a preview dialog", async () => {
  fixture.platform.openFile = vi
    .fn()
    .mockResolvedValue(undefined);
  const file = new File(["data"], "report.pdf");
  await preview().open(file);
  expect(fixture.platform.openFile).toHaveBeenCalledWith(
    file,
  );
  expect(fixture.dialog).not.toHaveBeenCalled();
});

it("keeps browser preview and send confirmation in the application", async () => {
  const file = new File(["data"], "report.txt");
  await preview().open(file);
  expect(fixture.openDialog).toHaveBeenCalledOnce();
  fixture.platform.openFile = vi.fn();
  const send = createRoot((dispose) => {
    disposers.push(dispose);
    return createSendItemPreviewDialog();
  });
  expect(await send.open(file, "Recipient")).toEqual({
    result: true,
  });
  expect(fixture.platform.openFile).not.toHaveBeenCalled();
  expect(fixture.openDialog).toHaveBeenCalledTimes(2);
});

it("reports native open failures in the UI without opening a preview", async () => {
  fixture.platform.openFile = vi
    .fn()
    .mockRejectedValue(new Error("No default application"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await preview().open(new File(["data"], "file.bin"));
  expect(fixture.error).toHaveBeenCalledWith(
    "common.notification.file_open_failed",
  );
  expect(fixture.dialog).not.toHaveBeenCalled();
});

it.each(["image/png", "video/mp4"])(
  "previews native %s thumbnails in the gallery without copying the file",
  (type) => {
    fixture.platform.openFile = vi
      .fn()
      .mockResolvedValue(undefined);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(
          () => "blob:local-file",
        );
        static revokeObjectURL = vi.fn();
      },
    );
    const src = "http://weblink-file.localhost/media";
    const read = vi.fn();
    const file = new RangeFile(
      "media",
      1024,
      type,
      1,
      read,
      src,
    );
    const route = {
      conversationId: "room",
      messageId: "message",
    };
    const view = render(() => (
      <LocalFileMedia file={file} route={route} />
    ));
    const link = screen.getByRole("link", {
      name: "common.action.preview: media",
    });
    expect(
      parseMediaHash(link.getAttribute("href")!),
    ).toEqual(route);
    expect(link).toHaveAttribute(
      "data-message-media",
      route.messageId,
    );
    expect(link).toHaveAttribute("data-pswp-src", src);
    if (type.startsWith("image/")) {
      const image = screen.getByRole("img");
      Object.defineProperties(image, {
        naturalWidth: { value: 640 },
        naturalHeight: { value: 480 },
      });
      fireEvent.load(image);
    } else {
      const video = view.container.querySelector("video")!;
      Object.defineProperties(video, {
        videoWidth: { value: 640 },
        videoHeight: { value: 480 },
      });
      fireEvent.loadedMetadata(video);
      expect(link).toHaveAttribute(
        "data-pswp-type",
        "video",
      );
      expect(link).toHaveAttribute(
        "data-pswp-video-src",
        src,
      );
    }
    expect(link).toHaveAttribute(
      "data-media-ready",
      "true",
    );
    expect(sourceForFileUrl(src)).toBe(file);
    expect(
      fixture.platform.openFile,
    ).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(sourceForFileUrl(src)).toBeUndefined();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  },
);
