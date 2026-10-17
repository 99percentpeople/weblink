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
  waitFor,
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
import { FileThumbnail } from "@/components/files/file-list";
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

function pagedFile(type: string) {
  const bytes = new TextEncoder().encode("stored bytes");
  return new RangeFile(
    "preview",
    bytes.length,
    type,
    1,
    async (offset, length) =>
      bytes.slice(offset, offset + length).buffer,
  );
}
function mockObjectUrls() {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:paged");
      static revokeObjectURL = vi.fn();
    },
  );
}

it.each([
  ["image/png", "img"],
  ["video/webm", "video"],
  ["audio/ogg", "audio"],
  ["application/pdf", "iframe"],
])(
  "previews paged %s files and releases their URL",
  async (type, tag) => {
    mockObjectUrls();
    await preview().open(pagedFile(type));
    const content =
      fixture.dialog.mock.lastCall![0].content;
    const view = render(() => content());
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        view.container.querySelector(tag),
      ).toHaveAttribute("src", "blob:paged"),
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type }),
    );
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:paged",
    );
  },
);

it("reads paged text directly and skips URL preparation for unsupported files", async () => {
  mockObjectUrls();
  const dialog = preview();
  await dialog.open(pagedFile("text/plain"));
  const content = fixture.dialog.mock.lastCall![0].content;
  render(() => content());
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveValue(
      "stored bytes",
    ),
  );
  await dialog.open(pagedFile("application/octet-stream"));
  expect(
    screen.getByText(
      "common.preview_dialog.unsupported_file_type",
    ),
  ).toBeInTheDocument();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("shows a readable error when paged storage fails", async () => {
  mockObjectUrls();
  const file = new RangeFile(
    "image",
    10,
    "image/png",
    1,
    async () => {
      throw new Error("File changed while reading");
    },
  );
  await preview().open(file);
  const content = fixture.dialog.mock.lastCall![0].content;
  render(() => content());
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("File changed while reading");
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("loads paged images in file lists and conversation thumbnails", async () => {
  mockObjectUrls();
  const file = pagedFile("image/png");
  const route = {
    conversationId: "room",
    messageId: "message",
  };
  const view = render(() => (
    <>
      <FileThumbnail
        file={{
          id: "image",
          fileName: "image.png",
          fileSize: file.size,
          mimetype: file.type,
          chunkSize: 1,
          file,
          isComplete: true,
        }}
      />
      <LocalFileMedia file={file} route={route} />
    </>
  ));
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(
        'img[src="blob:paged"]',
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByRole("link")).toHaveAttribute(
    "data-pswp-src",
    "blob:paged",
  );
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});
