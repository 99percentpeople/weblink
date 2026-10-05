// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { handleDropItems } from "@/libs/utils/process-file";

describe("drop file compatibility", () => {
  it("checks the clipboard budget before starting folder compression", async () => {
    const file = new File(["12345678"], "a.txt");
    const entry = {
      isFile: true,
      isDirectory: false,
      fullPath: "/folder/a.txt",
      file: (read: (file: File) => void) => read(file),
    };
    let batch = 0;
    const folder = {
      isDirectory: true,
      isFile: false,
      fullPath: "/folder",
      createReader: () => ({
        readEntries: (read: (entries: unknown[]) => void) =>
          read(batch++ === 0 ? [entry] : []),
      }),
    };
    const items = [
      { webkitGetAsEntry: () => folder },
    ] as unknown as DataTransferItemList;
    await expect(
      handleDropItems(items, undefined, {
        maxBytes: 4,
        maxEntries: 10,
      }),
    ).rejects.toThrow("64 MiB");
  });
  it("reads files when the browser does not expose directory entries", async () => {
    const file = new File(["a"], "a.txt");
    const items = [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => file },
    ] as unknown as DataTransferItemList;
    await expect(handleDropItems(items)).resolves.toEqual([
      file,
    ]);
  });

  it("rejects an already cancelled read", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      handleDropItems(
        [] as unknown as DataTransferItemList,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
