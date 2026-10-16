// @vitest-environment node
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { DirectoryVolume } from "@/libs/infrastructure/vfs/directory-volume";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import { encodeDirectoryFilename } from "@/libs/infrastructure/vfs/directory-filename";

beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  let saved = new File([], "program.exe");
  const chunks: BlobPart[] = [];
  const stream = {
    truncate: vi.fn(async () => {}),
    write: vi.fn(async (data: BlobPart) => {
      chunks.push(data);
    }),
    close: vi.fn(async () => {
      saved = new File(chunks, saved.name);
    }),
    abort: vi.fn(async () => {}),
  };
  const createWritable = vi.fn(async () => stream);
  const getFileHandle = vi.fn(async () => ({
    getFile: async () => saved,
    createWritable,
  }));
  const volume = new DirectoryVolume("directory", "Files", {
    queryPermission: async () => "granted",
    getFileHandle,
  } as unknown as FileSystemDirectoryHandle);
  return {
    volume,
    stream,
    createWritable,
    getFileHandle,
    file: () => saved,
  };
}

it("writes a complete multi-batch file in one transaction without committing empty or partial executable bytes", async () => {
  const f = fixture();
  const bytes = new Uint8Array(9 * 1024 * 1024 + 17).fill(
    43,
  );
  bytes[0] = 77;
  bytes[1] = 90;
  const file = new File([bytes], "program.exe");
  await f.volume.writeFile(file.name, file);
  expect(f.createWritable).toHaveBeenCalledOnce();
  expect(f.createWritable).toHaveBeenCalledWith({
    keepExistingData: false,
  });
  expect(f.stream.truncate).toHaveBeenCalledOnce();
  expect(f.stream.truncate).toHaveBeenCalledWith(file.size);
  expect(f.stream.close).toHaveBeenCalledOnce();
  expect(f.stream.abort).not.toHaveBeenCalled();
  expect(await f.file().arrayBuffer()).toEqual(
    bytes.buffer,
  );
});

it.each(["create", "write", "commit"] as const)(
  "preserves browser errors at the %s stage",
  async (stage) => {
    const f = fixture();
    const cause = new DOMException(
      "Browser refused this file",
      stage === "commit" ? "AbortError" : "NotAllowedError",
    );
    if (stage === "create")
      f.getFileHandle.mockRejectedValueOnce(cause);
    if (stage === "write")
      f.stream.write.mockRejectedValueOnce(cause);
    if (stage === "commit")
      f.stream.close.mockRejectedValueOnce(cause);
    const writing = f.volume.writeFile(
      "program.exe",
      new File(["MZ"], "program.exe"),
    );
    await expect(writing).rejects.toBeInstanceOf(
      DirectoryWriteError,
    );
    await expect(writing).rejects.toMatchObject({
      fileName: "program.exe",
      stage,
      cause,
    });
    expect(f.file().size).toBe(0);
  },
);

it("aborts before committing when the user cancels during copying", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.stream.write.mockImplementationOnce(async () =>
    controller.abort(),
  );
  await expect(
    f.volume.writeFile(
      "program.exe",
      new File(["MZ"], "program.exe"),
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.stream.close).not.toHaveBeenCalled();
  expect(f.stream.abort).toHaveBeenCalledOnce();
});

it.each(["upload", "checkpoint"] as const)(
  "reports the original name when an encoded %s fails its final save",
  async (operation) => {
    const f = fixture();
    const name = "nppc64_12.dll";
    const path = encodeDirectoryFilename(name);
    const cause = new DOMException(
      "Blocked by Safe Browsing.",
      "AbortError",
    );
    f.stream.close.mockRejectedValueOnce(cause);
    await expect(
      operation === "upload"
        ? f.volume.writeFile(path, new File(["MZ"], name))
        : f.volume.commit(path, [], 0),
    ).rejects.toMatchObject({
      fileName: name,
      stage: "commit",
      cause,
    });
    expect(f.createWritable).toHaveBeenCalledOnce();
    expect(f.stream.abort).toHaveBeenCalledOnce();
  },
);
