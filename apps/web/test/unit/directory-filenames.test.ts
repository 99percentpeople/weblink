// @vitest-environment node
import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { VfsVolume } from "@weblink/platform";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import {
  decodeDirectoryFilename,
  encodeDirectoryFilename,
} from "@/libs/infrastructure/vfs/directory-filename";
import { scanDirectory } from "@/libs/infrastructure/vfs/directory-index";

const resources: { dispose(): void }[] = [];
const databases: VfsDatabase[] = [];
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(async () => {
  resources
    .splice(0)
    .reverse()
    .forEach((resource) => resource.dispose());
  await Promise.all(
    databases.splice(0).map((db) => db.close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function database() {
  const db = new VfsDatabase(crypto.randomUUID());
  databases.push(db);
  return db;
}
function service(volume?: VfsVolume) {
  const storage = new FileStorageService(
    volume
      ? {
          volumes: async () => [volume],
          pickDirectory: async () => null,
          openDirectory: async () => {},
        }
      : undefined,
    database(),
  );
  resources.push(storage);
  return storage;
}
async function cache(
  storage: FileStorageService,
  id: string = crypto.randomUUID(),
  existingOnly = false,
) {
  const result = await storage.createCache(id, {
    memoryChunks: 4,
    isRetained: () => false,
    existingOnly,
  });
  resources.push({ dispose: () => result.dispose?.() });
  return result;
}
const blocked = () =>
  new TypeError(
    "Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.",
  );
async function fixture(
  kind: "directory" | "native" = "directory",
) {
  const backing = new IndexedDbVolume(database());
  const check = (path: string) => {
    if (kind === "directory" && /\.(dll|lnk)$/i.test(path))
      throw blocked();
  };
  const volume: VfsVolume = Object.assign(
    Object.create(backing),
    { id: "native-default", name: "Disk", kind },
  );
  const stat = vi.fn(async (path: string) => {
    check(path);
    return backing.stat(path);
  });
  volume.stat = stat;
  volume.commit = async (path, writes, size) => {
    check(path);
    return backing.commit(path, writes, size);
  };
  volume.writeFile = vi.fn(async (path, source) => {
    check(path);
    return backing.commit(
      path,
      [
        {
          offset: 0,
          data: new Uint8Array(await source.arrayBuffer()),
        },
      ],
      source.size,
    );
  });
  const storage = service(volume);
  await storage.initialize();
  const upload = async (name: string, text: string) => {
    const result = await cache(storage);
    const file = new File([text], name);
    await result.setInfo({
      fileName: name,
      fileSize: file.size,
      chunkSize: 4,
      file,
    });
    return result;
  };
  return { backing, volume, storage, stat, upload };
}
const scan = (volume: VfsVolume) =>
  scanDirectory(volume, new AbortController().signal);

it.each(["en-US", "zh-CN"])(
  "recovers original names and bytes with %s directory ordering and an empty metadata database",
  async (locale) => {
    const f = await fixture();
    const compare = new Intl.Collator(locale).compare;
    vi.spyOn(f.volume, "list").mockImplementation(
      async (path) =>
        (await f.backing.list(path)).sort((a, b) =>
          compare(a.name, b.name),
        ),
    );
    for (const name of [
      "nppc64_12.dll",
      "IObit Unlocker.lnk",
      "普通文件.txt",
    ]) {
      const uploaded = await f.upload(
        name,
        `content:${name}`,
      );
      const identity = await uploaded.storageIdentity!();
      const restarted = service(f.volume);
      const restored = await cache(
        restarted,
        identity,
        true,
      );
      const file = (await restored.getInfo())!.file!;
      expect(file.name).toBe(name);
      expect(await file.text()).toBe(`content:${name}`);
      expect(await restarted.database.all("files")).toEqual(
        [],
      );
      expect(
        await restarted.database.all("checkpoints"),
      ).toEqual([]);
    }
    const entries = await scan(f.volume);
    // Scanning preserves the volume's enumeration order. Recovery must retain
    // every path/name pair regardless of the host's collation rules.
    expect(entries).toHaveLength(3);
    expect(
      Object.fromEntries(
        entries.map((entry) => [
          entry.path,
          entry.info!.fileName,
        ]),
      ),
    ).toEqual({
      "IObit Unlocker.lnk.weblink": "IObit Unlocker.lnk",
      "nppc64_12.dll.weblink": "nppc64_12.dll",
      "普通文件.txt": "普通文件.txt",
    });
  },
);

it("preserves existing bytes and allocates distinct encoded names for concurrent imports", async () => {
  const f = await fixture();
  await f.upload("插件.dll", "original");
  await Promise.all([
    f.upload("插件.dll", "second"),
    f.upload("插件.dll", "third"),
  ]);
  const entries = await scan(f.volume);
  expect(
    entries.map((entry) => entry.info!.fileName).sort(),
  ).toEqual(["插件 (1).dll", "插件 (2).dll", "插件.dll"]);
  const original = await f.volume.file(
    encodeDirectoryFilename("插件.dll"),
    { name: "插件.dll", type: "", lastModified: 0 },
  );
  expect(await original.text()).toBe("original");
  expect(
    new Set(entries.map((entry) => entry.path)).size,
  ).toBe(3);
});

it("escapes literal suffixes on import and decodes one layer when scanning external files", async () => {
  const f = await fixture();
  const literal = "name.dll.weblink";
  const unrelated = "notes.weblink.backup";
  const external = "external.dll.weblink";
  await f.upload(literal, "literal name");
  for (const path of [unrelated, external])
    await f.backing.commit(
      path,
      [
        {
          offset: 0,
          data: new TextEncoder().encode("external"),
        },
      ],
      8,
    );
  const entries = await scan(f.volume);
  expect(
    entries.find(
      (entry) => entry.info!.fileName === literal,
    )?.path,
  ).toBe("name.dll.weblink.weblink");
  expect(
    entries.find((entry) => entry.path === unrelated)?.info!
      .fileName,
  ).toBe(unrelated);
  expect(
    entries.find((entry) => entry.path === external)?.info!
      .fileName,
  ).toBe("external.dll");
});

it("resumes an encoded partial from its file alone and retains the original name after completion and deletion", async () => {
  const f = await fixture();
  const partial = await cache(f.storage, "receive");
  await partial.setInfo({
    fileName: "resume.dll",
    fileSize: 10,
    chunkSize: 4,
  });
  expect(
    (await f.volume.list("")).map((entry) => entry.name),
  ).toEqual(["resume.dll.weblink.part"]);
  expect(
    await f.volume.stat("resume.dll.weblink"),
  ).toBeNull();
  await partial.storeChunk(0, new Uint8Array(4).buffer);
  await partial.storeChunk(
    2,
    new Uint8Array([9, 10]).buffer,
  );
  await partial.flush();
  partial.dispose?.();
  const restarted = service(f.volume);
  const resumed = await cache(restarted, "receive", true);
  expect((await resumed.getInfo())?.fileName).toBe(
    "resume.dll",
  );
  expect(await resumed.getReqRanges()).toEqual([1]);
  expect(await resumed.calcCachedBytes()).toBe(6);
  await resumed.storeChunk(
    1,
    new Uint8Array([5, 6, 7, 8]).buffer,
  );
  const file = (await resumed.getFile())!;
  expect(file.name).toBe("resume.dll");
  expect([
    ...new Uint8Array(await file.arrayBuffer()),
  ]).toEqual([0, 0, 0, 0, 5, 6, 7, 8, 9, 10]);
  const entry = (await scan(f.volume))[0];
  expect(entry.info?.fileName).toBe("resume.dll");
  expect(entry.complete).toBe(true);
  expect(entry.path).toBe("resume.dll.weblink");
  expect(
    await f.volume.stat("resume.dll.weblink.part"),
  ).toBeNull();
  const completed = await cache(
    service(f.volume),
    entry.id,
    true,
  );
  expect((await completed.getFile())?.name).toBe(
    "resume.dll",
  );
  await completed.cleanup({ deleteSource: true });
  expect(await scan(f.volume)).toEqual([]);
});

it("handles name rejection during creation even when the preceding stat succeeds", async () => {
  const f = await fixture();
  f.stat.mockImplementation((path) => f.backing.stat(path));
  vi.mocked(f.volume.writeFile!).mockImplementationOnce(
    async () => {
      throw new DirectoryWriteError(
        "late.dll",
        "create",
        blocked(),
      );
    },
  );
  const result = await f.upload("late.dll", "payload");
  expect((await result.getFile())?.name).toBe("late.dll");
  expect((await scan(f.volume))[0].path).toBe(
    encodeDirectoryFilename("late.dll"),
  );
});

it.each(["write", "commit"] as const)(
  "does not retry a %s rejection under a different name",
  async (stage) => {
    const f = await fixture();
    const cause = new DirectoryWriteError(
      "program.exe",
      stage,
      blocked(),
    );
    vi.mocked(f.volume.writeFile!).mockRejectedValue(cause);
    await expect(
      f.upload("program.exe", "payload"),
    ).rejects.toBe(cause);
    expect(f.volume.writeFile).toHaveBeenCalledOnce();
    expect(
      f.stat.mock.calls.some(([path]) =>
        path.endsWith(".weblink"),
      ),
    ).toBe(false);
  },
);

it("does not turn a permission error into a filename retry", async () => {
  const f = await fixture();
  f.stat.mockImplementation(async (path) => {
    if (path)
      throw new DOMException(
        "Access denied",
        "NotAllowedError",
      );
    return f.backing.stat(path);
  });
  await expect(
    f.upload("program.dll", "payload"),
  ).rejects.toMatchObject({
    stage: "create",
    cause: { name: "NotAllowedError" },
  });
  expect(f.volume.writeFile).not.toHaveBeenCalled();
  expect(
    f.stat.mock.calls.some(([path]) =>
      path.endsWith(".weblink"),
    ),
  ).toBe(false);
});

it("does not encode or decode native files or IndexedDB files", async () => {
  const f = await fixture("native");
  const encoded = encodeDirectoryFilename("program.dll");
  for (const name of ["program.dll", encoded]) {
    await f.upload(name, name);
    const indexed = await cache(service());
    await indexed.setInfo({
      fileName: name,
      fileSize: name.length,
      file: new File([name], name),
    });
    expect((await indexed.getFile())?.name).toBe(name);
  }
  expect(
    (await scan(f.volume))
      .map((entry) => entry.info!.fileName)
      .sort(),
  ).toEqual(["program.dll", encoded].sort());
  expect(
    (await f.volume.list(""))
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["program.dll", encoded].sort());
  expect(decodeDirectoryFilename(encoded)).toBe(
    "program.dll",
  );
});
