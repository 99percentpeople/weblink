// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { DirectoryVolume } from "@/libs/infrastructure/vfs/directory-volume";
import {
  RangeFile,
  type VfsVolume,
} from "@weblink/platform";
const resources: FileStorageService[] = [];
const databases: VfsDatabase[] = [];
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("File", NodeFile);
});
afterEach(async () => {
  resources.splice(0).forEach((s) => s.dispose());
  await Promise.all(
    databases.splice(0).map((db) => db.close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const bytes = (value: string) =>
  new TextEncoder().encode(value);
function database() {
  const db = new VfsDatabase(crypto.randomUUID());
  databases.push(db);
  return db;
}
function browserDirectory() {
  const files = new Map<string, File>();
  let revision = 0;
  const writes = vi.fn();
  const closes = vi.fn();
  const opens = vi.fn();
  const reads = vi.fn();
  let denied = false;
  const handle = (name: string) => ({
    kind: "file",
    name,
    getFile: async () => {
      reads(name);
      if (!files.has(name))
        throw new DOMException("Missing", "NotFoundError");
      return files.get(name)!;
    },
    createWritable: async () => {
      opens();
      const swap = `${name}.crswap`;
      files.set(swap, new File([], swap));
      let content = new Uint8Array(0);
      let position = 0;
      return {
        write: async (
          input:
            | Uint8Array<ArrayBuffer>
            | {
                type: "write";
                position: number;
                data: Uint8Array<ArrayBuffer>;
              },
        ) => {
          if (denied)
            throw new DOMException(
              "Permission lost",
              "NotAllowedError",
            );
          writes();
          const data =
            input instanceof Uint8Array
              ? input
              : input.data;
          if (!(input instanceof Uint8Array))
            position = input.position;
          const next = new Uint8Array(
            Math.max(
              content.length,
              position + data.length,
            ),
          );
          next.set(content);
          next.set(data, position);
          position += data.length;
          content = next;
          files.set(
            swap,
            new File([content], swap, {
              lastModified: ++revision,
            }),
          );
        },
        close: async () => {
          closes();
          files.set(
            name,
            new File([content], name, {
              lastModified: ++revision,
              type: "video/webm",
            }),
          );
          files.delete(swap);
        },
        abort: async () => {
          files.delete(swap);
        },
      };
    },
  });
  const root = {
    queryPermission: async () =>
      denied ? "denied" : "granted",
    requestPermission: async () =>
      denied ? "denied" : "granted",
    getFileHandle: async (
      name: string,
      options?: { create?: boolean },
    ) => {
      if (!files.has(name)) {
        if (!options?.create)
          throw new DOMException(
            "Missing",
            "NotFoundError",
          );
        files.set(
          name,
          new File([], name, { lastModified: ++revision }),
        );
      }
      return handle(name);
    },
    removeEntry: async (name: string) => {
      files.delete(name);
    },
    async *entries() {
      for (const name of files.keys())
        yield [name, handle(name)];
    },
  };
  const volume = new DirectoryVolume(
    "native-default",
    "Browser directory",
    root as unknown as FileSystemDirectoryHandle,
  );
  vi.spyOn(volume, "watch").mockResolvedValue(() => {});
  return {
    volume,
    files,
    opens,
    closes,
    writes,
    reads,
    deny: () => {
      denied = true;
    },
  };
}
async function fixture(
  kind: "indexeddb" | "directory" | "native",
) {
  const browser = browserDirectory();
  const backing = new IndexedDbVolume(database());
  const native: VfsVolume = Object.assign(
    Object.create(backing),
    {
      id: "native-default",
      kind: "native",
      name: "Native test volume",
      move: vi.fn(
        async (path: string, destination: string) => {
          if (await backing.stat(destination)) return null;
          const stat = (await backing.stat(path))!;
          const result = await backing.commit(
            destination,
            [
              {
                offset: 0,
                data: new Uint8Array(
                  await backing.read(path, 0, stat.size),
                ),
              },
            ],
            stat.size,
          );
          await backing.remove(path);
          return result;
        },
      ),
    },
  );
  const selected =
    kind === "directory" ? browser.volume : native;
  const storage = new FileStorageService(
    kind === "indexeddb"
      ? undefined
      : {
          volumes: async () => [selected],
          pickDirectory: async () => null,
          openDirectory: async () => {},
        },
    database(),
  );
  resources.push(storage);
  await storage.initialize();
  const volume = await storage.getVolume(
    storage.defaultMountId,
  );
  return { storage, volume, browser };
}
it.each(["indexeddb", "directory", "native"] as const)(
  "writes an unknown-length %s recording and pins the starting mount",
  async (kind) => {
    const f = await fixture(kind);
    const session = await f.storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    });
    await session.write(bytes("first"));
    const snapshot = await f.storage.synchronize();
    expect(snapshot.files).toHaveLength(1);
    const draft = await f.storage.createCache(
      snapshot.files[0],
      { memoryChunks: 0, isRetained: () => false },
    );
    expect(await draft.getInfo()).toMatchObject({
      fileName: "recording.webm",
      isComplete: false,
    });
    expect((await draft.getInfo())?.file).toBeUndefined();
    expect(await draft.getFile()).toBeNull();
    expect(await draft.getChunk(0)).toBeNull();
    expect(await draft.getReqRanges()).toBeNull();
    await expect(
      f.storage.removeSource(snapshot.files[0]),
    ).rejects.toThrow("Stop recording");
    await f.storage.setDefault("indexeddb");
    await session.write(bytes("last"));
    const result = await session.finish([
      { offset: 0, data: bytes("FIRST") },
    ]);
    expect(await result.file.text()).toBe("FIRSTlast");
    expect(result.file.name).toBe("recording.webm");
    const final = await f.storage.synchronize();
    expect(final.files).toEqual([result.id]);
    const cache = await f.storage.createCache(result.id, {
      memoryChunks: 0,
      isRetained: () => false,
    });
    expect(await cache.getInfo()).toMatchObject({
      isComplete: true,
      storageMountId: session.mountId,
    });
    const compute = vi.fn();
    await cache.fingerprint!(
      (await cache.getFile()) as File,
      {},
      compute,
    );
    expect(compute).not.toHaveBeenCalled(); // Reuses the final version's verification.
    if (kind === "directory") {
      expect(f.browser.opens).toHaveBeenCalledTimes(2);
      expect(f.browser.closes).toHaveBeenCalledTimes(2);
    }
  },
);
it.each(["indexeddb", "directory", "native"] as const)(
  "retains an incomplete %s draft if a metadata patch is invalid",
  async (kind) => {
    const f = await fixture(kind);
    const session = await f.storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    });
    await session.write(bytes("data"));
    await expect(
      session.finish([
        { offset: 4, data: bytes("beyond end") },
      ]),
    ).rejects.toThrow("Invalid file metadata update");
    const snapshot = await f.storage.synchronize();
    const cache = await f.storage.createCache(
      snapshot.files[0],
      { memoryChunks: 0, isRetained: () => false },
    );
    expect((await cache.getInfo())?.isComplete).toBe(false);
    expect(await cache.getFile()).toBeNull();
  },
);
it.each(["indexeddb", "directory", "native"] as const)(
  "never promotes an empty or aborted %s draft on directory synchronization",
  async (kind) => {
    const f = await fixture(kind);
    const session = await f.storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    });
    await session.abort();
    const snapshot = await f.storage.synchronize();
    expect(snapshot.files).toHaveLength(1);
    const cache = await f.storage.createCache(
      snapshot.files[0],
      { memoryChunks: 0, isRetained: () => false },
    );
    expect(await cache.getInfo()).toMatchObject({
      fileName: "recording.webm",
      isComplete: false,
    });
    await expect(session.finish()).rejects.toThrow();
    await f.storage.removeSource(snapshot.files[0]);
    expect((await f.storage.synchronize()).files).toEqual(
      [],
    );
  },
);
it.each(["directory", "native"] as const)(
  "preserves a same-name %s file and uses another name",
  async (kind) => {
    const f = await fixture(kind);
    const existing = await f.volume.openWriter!(
      "recording.webm",
    );
    await existing.write(bytes("existing"));
    await existing.close();
    const session = await f.storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    });
    await session.write(bytes("recorded"));
    const result = await session.finish();
    expect(result.file.name).toBe("recording (1).webm");
    expect(await result.file.text()).toBe("recorded");
    expect(
      new TextDecoder().decode(
        await f.volume.read("recording.webm", 0, 8),
      ),
    ).toBe("existing");
  },
);
it("keeps browser output uncommitted until close and reports lost permissions", async () => {
  const f = await fixture("directory");
  const session = await f.storage.createWritableFile({
    name: "recording.webm",
    type: "video/webm",
  });
  await session.write(bytes("first"));
  expect([...f.browser.files.values()][0].size).toBe(0);
  f.browser.deny();
  await expect(
    session.write(bytes("last")),
  ).rejects.toThrow();
  await expect(session.finish()).rejects.toThrow();
  expect(f.browser.closes).not.toHaveBeenCalled();
});

it("prepares a directory recording without scanning unrelated files and still refreshes imports", async () => {
  const f = await fixture("directory");
  const list = vi.spyOn(f.volume, "list");
  await f.storage.authorizeDefault({ refresh: false });
  const session = await f.storage.createWritableFile({
    name: "recording.webm",
    type: "video/webm",
  });
  expect(list).not.toHaveBeenCalled();
  const changed = vi.fn();
  const stop = f.storage.onChange(changed);
  const stat = vi.spyOn(f.volume, "stat");
  try {
    await session.write(bytes("first"));
    await session.write(bytes("last"));
    expect(stat).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    f.browser.files.set(
      "external.txt",
      new File(["external"], "external.txt"),
    );
    await f.storage.authorizeDefault();
    expect(list).toHaveBeenCalled();
    expect(await f.storage.list()).toHaveLength(2);
    await session.finish();
  } finally {
    stop();
  }
});

it("does not wait for an in-flight background scan before creating a recording", async () => {
  const f = await fixture("directory");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.volume.list.bind(f.volume);
  const list = vi
    .spyOn(f.volume, "list")
    .mockImplementationOnce(async (path) => {
      await blocked;
      return original(path);
    });
  const scan = f.storage.synchronize();
  await vi.waitFor(() =>
    expect(list).toHaveBeenCalledOnce(),
  );
  const prepared = vi.fn();
  const preparing = f.storage.createWritableFile({
    name: "recording.webm",
    type: "video/webm",
  });
  void preparing.then(prepared, () => {});
  try {
    await vi.waitFor(() =>
      expect(prepared).toHaveBeenCalledOnce(),
    );
    const writer = await preparing;
    await writer.write(bytes("recorded while scanning"));
    expect(list).toHaveBeenCalledOnce();
  } finally {
    release();
    await scan;
    await (await preparing).abort();
  }
});

it.each(["directory", "native"] as const)(
  "keeps a dot-prefixed recording hidden in the %s catalog throughout its lifetime",
  async (kind) => {
    const f = await fixture(kind);
    const session = await f.storage.createWritableFile({
      name: ".private.webm",
      type: "video/webm",
    });
    await session.write(bytes("private recording"));
    expect((await f.storage.synchronize()).files).toEqual(
      [],
    );
    const result = await session.finish();
    expect(await result.file.text()).toBe(
      "private recording",
    );
    expect((await f.storage.synchronize()).files).toEqual(
      [],
    );
    expect(
      (await f.volume.stat(".private.webm"))?.size,
    ).toBe(17);
  },
);

it("keeps one unavailable draft while Chromium's transaction file grows", async () => {
  const f = await fixture("directory");
  const session = await f.storage.createWritableFile({
    name: "recording.webm",
    type: "video/webm",
  });
  await session.write(bytes("first"));
  const draft = [...f.browser.files.keys()].find((name) =>
    name.endsWith(".recording.part"),
  )!;
  expect(f.browser.files.get(`${draft}.crswap`)?.size).toBe(
    5,
  );
  f.browser.files.set(
    `${draft}.1.crswap`,
    new File(["other transaction"], `${draft}.1.crswap`),
  );
  f.browser.files.set(
    ".hidden",
    new File(["private"], ".hidden"),
  );
  f.browser.reads.mockClear();
  const first = await f.storage.synchronize();
  expect(first.files).toHaveLength(1);
  const cache = await f.storage.createCache(
    first.files[0],
    { memoryChunks: 0, isRetained: () => false },
  );
  expect((await cache.getInfo())?.isComplete).toBe(false);
  expect(await cache.getFile()).toBeNull();
  await session.write(bytes("last"));
  expect((await f.storage.synchronize()).files).toEqual(
    first.files,
  );
  expect(
    f.browser.reads.mock.calls.every(
      ([name]) =>
        !name.startsWith(".") && !name.endsWith(".crswap"),
    ),
  ).toBe(true);
  expect(f.browser.files.has(`${draft}.crswap`)).toBe(true);
  const result = await session.finish();
  expect(await result.file.text()).toBe("firstlast");
  expect((await f.storage.synchronize()).files).toEqual([
    result.id,
  ]);
  expect(f.browser.files.has(".hidden")).toBe(true);
});

it("still rejects denied write permission without a directory scan", async () => {
  const f = await fixture("directory");
  f.browser.deny();
  const list = vi.spyOn(f.volume, "list");
  await expect(
    f.storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    }),
  ).rejects.toThrow("Directory access was not granted");
  expect(list).not.toHaveBeenCalled();
  expect(f.browser.opens).not.toHaveBeenCalled();
});
it("snapshots concurrent writes and reads IndexedDB lazily with revision checks", async () => {
  const volume = new IndexedDbVolume(database());
  const writer = await volume.openWriter("recording");
  const data = bytes("first");
  const a = writer.write(data);
  data.fill(0);
  const b = writer.write(bytes("last"));
  await Promise.all([a, b]);
  await writer.close();
  const read = vi.spyOn(volume, "read");
  const file = await volume.file("recording", {
    name: "recording.webm",
    type: "video/webm",
    lastModified: 0,
  });
  expect(file).toBeInstanceOf(RangeFile);
  expect(read).not.toHaveBeenCalled();
  expect(await file.slice(5).text()).toBe("last");
  await volume.commit("recording", [
    { offset: 0, data: bytes("other") },
  ]);
  await expect(file.text()).rejects.toThrow("changed");
});
it("retains an IndexedDB draft if publishing completion fails", async () => {
  const f = await fixture("indexeddb");
  const writer = await f.storage.createWritableFile({
    name: "movie.webm",
    type: "video/webm",
  });
  await writer.write(bytes("committed"));
  const id = (await f.storage.synchronize()).files[0];
  vi.spyOn(f.storage.database, "put").mockRejectedValueOnce(
    new DOMException(
      "No space for completion metadata",
      "QuotaExceededError",
    ),
  );
  await expect(writer.finish()).rejects.toThrow("No space");
  const cache = await f.storage.createCache(id, {
    memoryChunks: 0,
    isRetained: () => false,
  });
  expect(await cache.getInfo()).toMatchObject({
    isComplete: false,
    cachedBytes: 9,
  });
  expect(await cache.getFile()).toBeNull();
});
it("lists committed IndexedDB drafts after reopening storage without promoting them", async () => {
  const name = crypto.randomUUID();
  const first = new FileStorageService(
    undefined,
    new VfsDatabase(name),
  );
  resources.push(first);
  await first.initialize();
  const session = await first.createWritableFile({
    name: "movie.webm",
    type: "video/webm",
  });
  await session.write(bytes("partial"));
  await session.abort();
  const second = new FileStorageService(
    undefined,
    new VfsDatabase(name),
  );
  resources.push(second);
  await second.initialize();
  const ids = (await second.synchronize()).files;
  expect(ids).toHaveLength(1);
  const cache = await second.createCache(ids[0], {
    memoryChunks: 0,
    isRetained: () => false,
  });
  expect(await cache.getInfo()).toMatchObject({
    isComplete: false,
    cachedBytes: 7,
  });
  expect(await cache.getFile()).toBeNull();
});
