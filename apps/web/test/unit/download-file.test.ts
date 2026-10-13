// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { toast } from "solid-sonner";
import { platform } from "@/libs/platform/runtime";
import {
  downloadFile,
  downloadUrl,
  saveFile,
} from "@/libs/utils/download-file";

vi.mock("@/libs/platform/runtime", () => ({
  platform: { saveFile: undefined },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));

const createUrl = vi.fn(() => "blob:received-file");
const revokeUrl = vi.fn();
beforeEach(() => {
  platform.saveFile = undefined;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("routes received files to the desktop saver rather than a WebView blob navigation", async () => {
  const file = new File(["received"], "report.txt");
  const nativeSave = vi.fn().mockResolvedValue(true);
  platform.saveFile = nativeSave;
  await saveFile(file, file.name);
  expect(nativeSave).toHaveBeenCalledWith(
    file,
    "report.txt",
    undefined,
  );
  expect(createUrl).not.toHaveBeenCalled();
});

it("preserves automatic download intent and treats cancellation quietly", async () => {
  const file = new File(["received"], "report.txt");
  const nativeSave = vi.fn().mockResolvedValue(false);
  platform.saveFile = nativeSave;
  downloadFile(file, { automatic: true });
  await Promise.resolve();
  expect(nativeSave).toHaveBeenCalledWith(
    file,
    "report.txt",
    { automatic: true },
  );
  expect(toast.error).not.toHaveBeenCalled();
});

it("reports native save failures instead of silently doing nothing", async () => {
  platform.saveFile = vi
    .fn()
    .mockRejectedValue(new Error("Disk full"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  downloadFile(new File(["received"], "report.txt"));
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "common.notification.file_save_failed",
    ),
  );
});

it("saves gallery object URL content through the same native path", async () => {
  const blob = new Blob(["image"]);
  const fetchFile = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => blob,
  });
  const nativeSave = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchFile);
  platform.saveFile = nativeSave;
  downloadUrl("blob:gallery-image", "photo.png");
  await vi.waitFor(() =>
    expect(nativeSave).toHaveBeenCalledWith(
      blob,
      "photo.png",
      undefined,
    ),
  );
  expect(fetchFile).toHaveBeenCalledWith(
    "blob:gallery-image",
  );
});

it("keeps browser downloads with the original filename and releases the object URL later", async () => {
  vi.useFakeTimers();
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("report.txt");
      expect(this.href).toBe("blob:received-file");
    });
  await saveFile(new Blob(["received"]), "report.txt");
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector("a[download]")).toBeNull();
  expect(revokeUrl).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revokeUrl).toHaveBeenCalledWith(
    "blob:received-file",
  );
});
