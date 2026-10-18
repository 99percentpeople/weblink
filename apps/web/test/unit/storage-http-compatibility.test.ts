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
import type { ChunkCache } from "@/libs/domain/file";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { legacyDatabase } from "../helpers/legacy-indexeddb";

let database: VfsDatabase;
let storage: FileStorageService;
const caches: ChunkCache[] = [];
const bytes = (value: string) =>
  new TextEncoder().encode(value);

beforeEach(() => {
  // LAN HTTP exposes random bytes, but not randomUUID or subtle.
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("File", NodeFile);
  database = new VfsDatabase("http-storage-test");
  storage = new FileStorageService(undefined, database);
});
afterEach(async () => {
  caches.splice(0).forEach((cache) => cache.dispose?.());
  storage.dispose();
  await database.close();
  vi.unstubAllGlobals();
});
async function cache(id: string) {
  const value = await storage.createCache(id, {
    memoryChunks: 0,
    isRetained: () => false,
  });
  caches.push(value);
  await value.initialize();
  return value;
}

it("imports and reads back a file without crypto.randomUUID", async () => {
  const file = new File(["saved data"], "http.txt", {
    type: "text/plain",
    lastModified: 123,
  });
  const value = await cache("http-import");
  await value.setInfo({
    fileName: file.name,
    fileSize: file.size,
    chunkSize: 4,
    file,
  });
  expect(await value.isTransferComplete()).toBe(true);
  expect(await (await value.getFile())?.text()).toBe(
    "saved data",
  );
  expect((await storage.synchronize()).files).toEqual([
    value.id,
  ]);
});

it("appends and publishes distinct recordings without crypto.randomUUID", async () => {
  const ids: string[] = [];
  for (const content of ["first", "second"]) {
    const writer = await storage.createWritableFile({
      name: "recording.webm",
      type: "video/webm",
    });
    await writer.write(bytes(content));
    await writer.write(bytes("-end"));
    const saved = await writer.finish();
    ids.push(saved.id);
    expect(await saved.file.text()).toBe(`${content}-end`);
    expect(
      await (await cache(saved.id)).getInfo(),
    ).toMatchObject({
      isComplete: true,
      fileName: "recording.webm",
    });
  }
  expect(new Set(ids).size).toBe(2);
  expect(
    (await storage.synchronize()).files.sort(),
  ).toEqual(ids.sort());
});

it.each(["completed", "partial"])(
  "migrates a %s legacy file and preserves its data without crypto.randomUUID",
  async (kind) => {
    const id = `http-${kind}`;
    const file = new File(["data"], "legacy.txt", {
      type: "text/plain",
      lastModified: 123,
    });
    const legacy = await legacyDatabase(
      id,
      {
        fileName: file.name,
        fileSize: file.size,
        chunkSize: 2,
        file: kind === "completed" ? file : undefined,
      },
      kind === "partial"
        ? [{ chunkIndex: 1, data: bytes("ta").buffer }]
        : [],
    );
    legacy.close();
    const phases: string[] = [];
    storage.onMigrationProgress(({ phase }) =>
      phases.push(phase),
    );
    await storage.initialize();
    expect(storage.migrationProgress).toMatchObject({
      phase: "completed",
      completedFiles: 1,
      failures: [],
    });
    expect(phases).toContain("verifying");
    expect(phases.indexOf("deleting")).toBeGreaterThan(
      phases.indexOf("verifying"),
    );
    expect(
      (await indexedDB.databases()).map(({ name }) => name),
    ).not.toContain(`file-${id}`);
    const value = await cache(id);
    if (kind === "partial") {
      expect(await value.getFile()).toBeNull();
      expect(await value.getReqRanges()).toEqual([0]);
      await value.storeChunk(0, bytes("da").buffer);
      await value.flush();
    }
    expect(await (await value.getFile())?.text()).toBe(
      "data",
    );
    expect(await value.getInfo()).toMatchObject({
      id,
      fileName: file.name,
      isComplete: true,
    });
  },
);
