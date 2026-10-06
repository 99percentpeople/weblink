// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleDropItems } from "@/libs/utils/process-file";

afterEach(() => vi.unstubAllGlobals());

describe("drop file compatibility", () => {
  it("checks the configured file budget before starting folder compression", async () => {
    const worker = vi.fn();
    vi.stubGlobal("Worker", worker);
    const file = new File(
      [new Uint8Array(1024 * 1024 + 1)],
      "a.txt",
    );
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
        maxBytes: 1024 * 1024,
        maxEntries: 10,
      }),
    ).rejects.toThrow("1 MiB / 10 entries limit");
    expect(worker).not.toHaveBeenCalled();
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
