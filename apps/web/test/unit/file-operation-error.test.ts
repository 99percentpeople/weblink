// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { LocalFileSystemError } from "@weblink/platform";
import { toast } from "solid-sonner";
import { showFileOperationError } from "@/components/files/file-operation-error";
import { P2PProtocolError } from "@/libs/domain/protocol/errors";
import { StorageUnavailableError } from "@/libs/domain/vfs";
import { copyText } from "@/libs/utils/copy-text";

vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: Record<string, string>) =>
    [key, ...Object.values(values ?? {})].join(" "),
}));
vi.mock("@/libs/utils/copy-text", () => ({
  copyText: vi.fn(async () => true),
}));
beforeEach(() => vi.clearAllMocks());

it("keeps native allocation diagnostics visible and copies the exact failure details", async () => {
  const error = new LocalFileSystemError(
    "resize",
    "cublasLt64_12.dll.part",
    "There is not enough space on the disk. (os error 112)",
    { size: 643 * 1024 * 1024 },
  );
  showFileOperationError(
    new P2PProtocolError(
      "prepare-failed",
      "Local preparation failed",
      { cause: error },
    ),
  );
  const [title, options] = vi.mocked(toast.error).mock
    .calls[0];
  expect(title).toContain("storage.stage_create");
  expect(title).toContain("cublasLt64_12.dll.part");
  expect(options?.description).toBe(error.message);
  expect(options?.description).toContain("os error 112");
  expect(options?.description).toContain(
    `size=${643 * 1024 * 1024}`,
  );
  const action = options!.action;
  expect(action).toHaveProperty("onClick");
  if (
    !action ||
    typeof action !== "object" ||
    !("onClick" in action)
  )
    throw new Error("Missing diagnostic copy action");
  const event = new MouseEvent("click", {
    cancelable: true,
  });
  const preventDefault = vi.spyOn(event, "preventDefault");
  action.onClick(event);
  await Promise.resolve();
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(copyText).toHaveBeenCalledWith(
    `${title}\n${error.message}`,
  );
});

it("preserves a local storage failure even after a directory refresh stored its diagnostic message", () => {
  const detail =
    "vfs_read: cublasLt64_12.dll.part: Access is denied. (os error 5)";
  showFileOperationError(
    new StorageUnavailableError(detail),
  );
  expect(
    vi.mocked(toast.error).mock.calls[0][1]?.description,
  ).toContain(detail);
});

it.each([
  new P2PProtocolError(
    "remote-error",
    "Internal failure token=private",
  ),
  new Error("Unknown server failure"),
])(
  "keeps arbitrary server failures behind the translated error boundary",
  (error) => {
    showFileOperationError(error);
    expect(toast.error).toHaveBeenCalledWith(
      "errors.file_failed",
    );
  },
);
