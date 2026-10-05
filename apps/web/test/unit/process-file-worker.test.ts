// @vitest-environment node
import { expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
it("preserves empty directories and file bytes in a folder ZIP", async () => {
  const postMessage = vi.fn();
  const worker = {
    postMessage,
    onmessage: undefined as unknown as (
      event: unknown,
    ) => Promise<void>,
  };
  vi.stubGlobal("self", worker);
  try {
    await import("@/libs/utils/process-file-worker");
    await worker.onmessage({
      data: {
        folderName: "folder",
        fileMap: {
          folder: null,
          "folder/empty": null,
          "folder/a.txt": new File(["hello"], "a.txt"),
        },
      },
    });
    const result = postMessage.mock.calls[0][0];
    expect(result.error).toBeUndefined();
    expect(result.data.name).toBe("folder.zip");
    const files = unzipSync(
      new Uint8Array(await result.data.arrayBuffer()),
    );
    expect(Object.keys(files).sort()).toEqual([
      "folder/",
      "folder/a.txt",
      "folder/empty/",
    ]);
    expect(
      new TextDecoder().decode(files["folder/a.txt"]),
    ).toBe("hello");
    expect(files["folder/empty/"].length).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});
