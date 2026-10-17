// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { RangeFile } from "@weblink/platform";
import {
  fileObjectUrl,
  revokeFileUrl,
  sourceForFileUrl,
} from "@/libs/utils/stored-file";

afterEach(() => vi.restoreAllMocks());

it("prepares paged files for preview with their MIME type and bounded reads", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 29);
  bytes.forEach((_, index) => (bytes[index] = index % 251));
  const read = vi.fn(
    async (offset: number, length: number) =>
      bytes.slice(offset, offset + length).buffer,
  );
  const file = new RangeFile(
    "clip.webm",
    bytes.length,
    "video/webm",
    1,
    read,
  );
  const entireFile = vi.spyOn(file, "arrayBuffer");
  const url = await fileObjectUrl(file);
  try {
    const response = await fetch(url);
    expect(response.headers.get("content-type")).toBe(
      "video/webm",
    );
    expect(
      Buffer.from(await response.arrayBuffer()).equals(
        bytes,
      ),
    ).toBe(true);
    expect(entireFile).not.toHaveBeenCalled();
    expect(read.mock.calls).toEqual([
      [0, 1024 * 1024],
      [1024 * 1024, 1024 * 1024],
      [2 * 1024 * 1024, 29],
    ]);
  } finally {
    revokeFileUrl(url);
  }
});

it("keeps Blob previews immediate", async () => {
  const file = new File(["image"], "image.png", {
    type: "image/png",
  });
  const url = fileObjectUrl(file);
  expect(typeof url).toBe("string");
  try {
    expect(await (await fetch(url as string)).text()).toBe(
      "image",
    );
  } finally {
    revokeFileUrl(url as string);
  }
});

it("retains native capabilities until their last preview closes, without reading bytes", () => {
  const read = vi.fn();
  const file = new RangeFile(
    "clip",
    100,
    "video/mp4",
    1,
    read,
    "http://weblink-file.localhost/clip",
  );
  const first = fileObjectUrl(file);
  const second = fileObjectUrl(file);
  expect(first).toBe(file.url);
  expect(second).toBe(first);
  expect(sourceForFileUrl(first as string)).toBe(file);
  revokeFileUrl(first as string);
  expect(sourceForFileUrl(first as string)).toBe(file);
  revokeFileUrl(second as string);
  expect(sourceForFileUrl(first as string)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it("propagates storage errors without publishing a partial preview", async () => {
  const create = vi.spyOn(URL, "createObjectURL");
  const error = new Error("File changed while reading");
  const file = new RangeFile(
    "clip",
    100,
    "video/webm",
    1,
    async () => {
      throw error;
    },
  );
  await expect(fileObjectUrl(file)).rejects.toBe(error);
  expect(create).not.toHaveBeenCalled();
});

it("cancels a paged preview when its owner closes", async () => {
  const controller = new AbortController();
  const create = vi.spyOn(URL, "createObjectURL");
  let finish!: (value: ArrayBuffer) => void;
  const read = vi.fn(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  );
  const file = new RangeFile(
    "clip",
    3 * 1024 * 1024,
    "video/webm",
    1,
    read,
  );
  const pending = fileObjectUrl(file, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() =>
    expect(read).toHaveBeenCalledOnce(),
  );
  controller.abort();
  finish(new ArrayBuffer(1024 * 1024));
  await rejected;
  expect(read).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});
