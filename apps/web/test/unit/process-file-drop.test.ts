// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { handleDropItems } from "@/libs/utils/process-file";

describe("drop file compatibility", () => {
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
