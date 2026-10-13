import { expect, it } from "vitest";
import { browserClipboardContent } from "@/libs/application/browser-clipboard-files";

it.each(["pdf", "webp", "gif", "bmp", "avif", "bin"])(
  "rejects copied %s files before attempting clipboard conversion",
  async (extension) => {
    await expect(
      browserClipboardContent(
        [
          {
            type: "file",
            name: `file.${extension}`,
            blob: new Blob(["data"]),
          },
        ],
        new AbortController().signal,
      ),
    ).rejects.toThrow("clipboard-file-unsupported");
  },
);

it("rejects a multiple-image selection without silently dropping files", async () => {
  await expect(
    browserClipboardContent(
      ["a.png", "b.jpg"].map((name) => ({
        type: "file",
        name,
        blob: new Blob(["data"]),
      })),
      new AbortController().signal,
    ),
  ).rejects.toThrow("clipboard-file-unsupported");
});
