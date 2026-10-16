// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { FileList } from "@/components/files/file-list";
import type { LibraryFile } from "@/libs/application/files/library-query";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconClose: () => null,
  IconPlaceItem: () => null,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps thumbnail URLs across list refreshes and unrelated progress, and releases them on replacement/removal", async () => {
  const createObjectURL = vi.fn(
    () =>
      `blob:preview-${createObjectURL.mock.calls.length}`,
  );
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL,
    revokeObjectURL,
  });
  const photo: LibraryFile = {
    id: "photo",
    fileName: "photo.png",
    fileSize: 5,
    mimetype: "image/png",
    file: new File(["image"], "photo.png", {
      type: "image/png",
    }),
    isComplete: true,
    referenceIds: ["photo"],
  };
  const partial: LibraryFile = {
    id: "partial",
    fileName: "part.bin",
    fileSize: 100,
    isComplete: false,
    cachedBytes: 0,
    referenceIds: ["partial"],
  };
  const [files, setFiles] = createSignal([photo, partial]);
  const view = render(() => (
    <FileList
      files={files()}
      selected={[]}
      onToggle={() => {}}
    />
  ));
  await waitFor(() =>
    expect(createObjectURL).toHaveBeenCalledOnce(),
  );
  const image = view.container.querySelector("img");
  for (
    let cachedBytes = 1;
    cachedBytes <= 3;
    cachedBytes++
  ) {
    setFiles([
      { ...photo, referenceIds: [...photo.referenceIds] },
      { ...partial, cachedBytes },
    ]);
    await Promise.resolve();
  }
  expect(view.container.querySelector("img")).toBe(image);
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(revokeObjectURL).not.toHaveBeenCalled();
  setFiles([
    {
      ...photo,
      file: new File(["replacement"], "photo.png", {
        type: "image/png",
      }),
    },
  ]);
  await waitFor(() =>
    expect(createObjectURL).toHaveBeenCalledTimes(2),
  );
  expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  setFiles([]);
  await waitFor(() =>
    expect(revokeObjectURL).toHaveBeenCalledTimes(2),
  );
});
