import { FileLibraryService } from "@/libs/application/file-library-service";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { File as NodeFile } from "node:buffer";
import { fakeCache } from "../support/file-transfer";

import { setupLibrary as setup } from "../support/file-library";
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => vi.unstubAllGlobals());

describe("shared file library", () => {
  it.each(["send-reference", undefined])(
    "associates send identification with the published reference (%s)",
    async (id) => {
      const f = setup();
      const file = new File(["abc"], "sample.bin");
      const controller = new AbortController();
      const onProgress = vi.fn();
      const cache = await f.library.prepare(
        file,
        { id, chunkSize: 2 },
        {
          signal: controller.signal,
          onProgress,
        },
      );
      expect(f.hash).toHaveBeenCalledWith(file, {
        fileId: cache.id,
        signal: controller.signal,
        onProgress,
      });
    },
  );

  it("associates receive verification with its cache ID rather than its filename", async () => {
    const f = setup();
    const cache = await f.storage("receive-reference");
    const file = new File(["abc"], "sample.bin");
    await cache.setInfo({
      fileName: file.name,
      fileSize: file.size,
      chunkSize: 2,
      file,
    });
    const controller = new AbortController();
    await f.library.verifyReceived(
      cache,
      controller.signal,
    );
    expect(f.hash).toHaveBeenCalledWith(file, {
      signal: controller.signal,
      fileId: "receive-reference",
    });
  });

  it("keeps standalone library imports independent from transfers", async () => {
    const f = setup();
    const file = new File(["abc"], "sample.bin");
    await f.library.importFile(file);
    expect(f.hash).toHaveBeenCalledWith(file, {});
  });

  it("imports equal bytes once, retains aliases, and distinguishes same-sized different content", async () => {
    const f = setup();
    const first = await f.library.importFile(
      new File(["one"], "a.txt", { lastModified: 1 }),
    );
    const duplicate = await f.library.importFile(
      new File(["one"], "b.txt", { lastModified: 2 }),
    );
    expect(duplicate.reused).toBe(true);
    expect(duplicate.cache.id).toBe(first.cache.id);
    expect(
      (await duplicate.cache.getInfo())?.aliases,
    ).toContain("b.txt");
    expect(f.raw.size).toBe(1);
    expect(
      [...f.raw.values()][0].setInfo,
    ).toHaveBeenCalledOnce();
    await f.library.importFile(
      new File(["two"], "a.txt", { lastModified: 1 }),
    );
    expect(f.raw.size).toBe(2);
  });
  it("creates independent room/private references without rehashing library selections", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["abcdef"], "source.txt"),
    );
    const source = {
      kind: "library" as const,
      localFileId: imported.cache.id,
    };
    const room = await f.library.prepare(source, {
      id: "room-file",
      roomAttachment: true,
      roomOfferId: "room-offer",
      from: "alice",
      chunkSize: 2,
      fileName: "room.txt",
    });
    const direct = await f.library.prepare(source, {
      id: "direct-file",
      chunkSize: 4,
      fileName: "private.txt",
    });
    expect(f.hash).toHaveBeenCalledOnce();
    expect(f.raw.size).toBe(1);
    expect((await room.getFile())?.name).toBe("room.txt");
    expect(
      new TextDecoder().decode((await room.getChunk(1))!),
    ).toBe("cd");
    expect(
      new TextDecoder().decode((await direct.getChunk(1))!),
    ).toBe("ef");
    expect(
      (await direct.getInfo())?.roomAttachment,
    ).toBeUndefined();
    await direct.cleanup();
    expect((await room.getFile())?.size).toBe(6);
    expect((await imported.cache.getFile())?.size).toBe(6);
  });
  it("reuses verified content for a new received offer and invalidates all aliases on explicit removal", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["content"], "local.txt"),
    );
    const info = (await imported.cache.getInfo())!;
    const received = await f.library.reuse(
      info.fingerprint!,
      {
        id: "remote-id",
        fileName: "remote.txt",
        fileSize: 7,
        chunkSize: 1024,
        from: "peer",
      },
    );
    expect((await received?.getFile())?.name).toBe(
      "remote.txt",
    );
    expect(f.raw.size).toBe(1);
    await f.library.removeFile(imported.cache.id);
    expect(await received?.getFile()).toBeNull();
    expect(f.repository.blobs.size).toBe(0);
    expect(f.repository.refs.size).toBe(0);
  });
  it("serializes simultaneous imports and never publishes a failed write", async () => {
    const f = setup();
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        f.library.importFile(
          new File(["same"], `${i}.txt`),
        ),
      ),
    );
    expect(
      new Set(results.map((item) => item.cache.id)).size,
    ).toBe(1);
    expect(f.raw.size).toBe(1);
    const broken = setup();
    const storage = broken.storage;
    const library = new FileLibraryService({
      repository: broken.repository,
      fingerprint: (file, options) =>
        fingerprintBlob(
          file,
          options?.onProgress,
          options?.signal,
        ),
      storage: async (id) => {
        const cache = await storage(id);
        cache.setInfo.mockRejectedValue(
          new DOMException("Full", "QuotaExceededError"),
        );
        return cache;
      },
      getCache: () => null,
      publish: vi.fn(),
    });
    await expect(
      library.importFile(new File(["x"], "file")),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(broken.repository.blobs.size).toBe(0);
    expect(broken.repository.refs.size).toBe(0);
  });
  it("rejects corrupt received bytes before adding them to the content index", async () => {
    const f = setup();
    const cache = fakeCache("incoming");
    await cache.setInfo({
      fileName: "wrong",
      fileSize: 3,
      file: new File(["bad"], "wrong"),
      fingerprint: await fingerprintBlob(
        new File(["yes"], "right"),
      ),
    });
    await expect(
      f.library.verifyReceived(cache),
    ).rejects.toThrow("verification failed");
    expect(cache.cleanup).toHaveBeenCalledOnce();
    expect(f.repository.blobs.size).toBe(0);
  });
  it("retains old file IDs while indexing legacy duplicates without another binary write", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["same"], "imported"),
    );
    const old = await f.storage("old-id");
    await old.setInfo({
      fileName: "old",
      fileSize: 4,
      chunkSize: 2,
      file: new File(["same"], "old"),
    });
    f.caches.set(old.id, old);
    const share = await f.library.prepare(
      { kind: "library", localFileId: old.id },
      { id: "new-id", chunkSize: 3 },
    );
    expect(
      (await f.repository.reference(old.id))?.contentKey,
    ).toBe((await imported.cache.getInfo())?.contentKey);
    expect((await share.getFile())?.name).toBe("old");
    expect(f.raw.size).toBe(2);
    expect(
      f.raw.get("old-id")?.setInfo,
    ).toHaveBeenCalledOnce();
  });
  it("treats an index whose bytes disappeared as a miss", async () => {
    const f = setup();
    const result = await f.library.importFile(
      new File(["same"], "file"),
    );
    const info = (await result.cache.getInfo())!;
    [...f.raw.values()][0].getInfo.mockRejectedValue(
      new Error("Storage missing"),
    );
    expect(
      await f.library.reuse(info.fingerprint!, {
        id: "remote",
        fileName: "remote",
        fileSize: 4,
      }),
    ).toBeNull();
    expect(f.repository.blobs.size).toBe(0);
    expect(f.repository.refs.size).toBe(0);
  });
  it("rolls back an alias if cancellation arrives during publication", async () => {
    const f = setup(),
      controller = new AbortController();
    const library = new FileLibraryService({
      repository: f.repository,
      fingerprint: (file) => fingerprintBlob(file),
      storage: f.storage,
      getCache: () => null,
      publish: async () => {
        controller.abort();
      },
    });
    await expect(
      library.importFile(new File(["data"], "file"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.repository.refs.size).toBe(0);
    expect(f.repository.blobs.size).toBe(0);
  });
  it("rejects a reused attachment ID with different room authorization or metadata", async () => {
    const f = setup();
    const local = await f.library.importFile(
      new File(["data"], "file"),
    );
    const fingerprint = (await local.cache.getInfo())!
      .fingerprint!;
    const info = {
      id: "room",
      fileName: "file",
      fileSize: 4,
      roomAttachment: true,
      roomOfferId: "offer-a",
      from: "alice",
      chunkSize: 2,
    };
    await f.library.reuse(fingerprint, info);
    await expect(
      f.library.reuse(fingerprint, {
        ...info,
        roomOfferId: "offer-b",
      }),
    ).rejects.toThrow("identity conflict");
    await expect(
      f.library.reuse(fingerprint, {
        ...info,
        chunkSize: 4,
      }),
    ).rejects.toThrow("identity conflict");
  });
});

describe("content-owned sharing", () => {
  it("defaults imports and legacy records to private, ignores received flags, and projects one state to every reference", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["shared bytes"], "local.txt"),
    );
    expect((await imported.cache.getInfo())?.isShared).toBe(
      false,
    );
    const room = await f.library.prepare(
      { kind: "library", localFileId: imported.cache.id },
      {
        id: "room",
        roomAttachment: true,
        roomOfferId: "offer",
        isShared: true,
      },
    );
    expect((await room.getInfo())?.isShared).toBe(false);
    expect(await f.library.sharedFiles()).toEqual([]);
    await f.library.setShared(room.id, true);
    expect((await imported.cache.getInfo())?.isShared).toBe(
      true,
    );
    expect((await room.getInfo())?.isShared).toBe(true);
    const [shared] = await f.library.sharedFiles();
    expect(shared.id).not.toBe(room.id);
    expect(shared.fingerprint).toEqual(
      (await room.getInfo())?.fingerprint,
    );
    expect(shared.roomAttachment).toBeUndefined();
    expect(
      await f.library.getSharedFile(room.id),
    ).toBeNull();
    await f.library.releaseAttachment(room.id);
    expect(
      await f.library.getSharedFile(shared.id),
    ).not.toBeNull();
    expect(f.raw.size).toBe(1);
    await f.library.setShared(imported.cache.id, false);
    const duplicate = await f.library.importFile(
      new File(["shared bytes"], "alias.txt"),
    );
    expect(
      (await duplicate.cache.getInfo())?.isShared,
    ).toBe(false);
    expect(await f.library.sharedFiles()).toEqual([]);
    expect(await imported.cache.getFile()).not.toBeNull();
    await f.library.setShared(imported.cache.id, true);
    expect(
      (await duplicate.cache.getInfo())?.isShared,
    ).toBe(true);
    await f.library.removeFile(imported.cache.id);
    expect(await f.library.sharedFiles()).toEqual([]);
    expect(
      await f.library.getSharedFile(shared.id),
    ).toBeNull();
  });
  it("retains shared bytes after all chat references are released, including after reopening and unsharing", async () => {
    const f = setup();
    const attachment = await f.library.prepare(
      new File(["retained"], "sent.txt"),
      { id: "chat-file" },
    );
    await f.library.setShared(attachment.id, true);
    const [shared] = await f.library.sharedFiles();
    await f.library.releaseAttachment(attachment.id);
    await f.library.refresh();
    expect(
      await (
        await f.library.getSharedFile(shared.id)
      )?.getFile(),
    ).not.toBeNull();
    const revoked = vi.fn();
    f.library.onUnshare(revoked);
    await f.library.setShared(shared.id, false);
    expect(revoked).toHaveBeenCalledWith([shared.id]);
    expect(
      await f.caches.get(shared.id)?.getFile(),
    ).not.toBeNull();
    await f.library.setShared(shared.id, true);
    expect((await f.library.sharedFiles())[0].id).toBe(
      shared.id,
    );
  });
  it("preserves locally shared state on duplicate receives and never inherits a remote sharing flag", async () => {
    const f = setup();
    const original = await f.library.importFile(
      new File(["content"], "a.txt"),
    );
    const info = (await original.cache.getInfo())!;
    await f.library.setShared(original.cache.id, true);
    const reused = await f.library.reuse(
      info.fingerprint!,
      { ...info, id: "received", isShared: false },
    );
    expect((await reused?.getInfo())?.isShared).toBe(true);
    await f.library.setShared("received", false);
    const received = fakeCache("new-received");
    await received.setInfo({
      file: new File(["new"], "new.txt"),
      fileName: "new.txt",
      fileSize: 3,
      fingerprint: undefined,
      isShared: true,
      sharedReference: true,
    });
    await f.library.verifyReceived(received);
    expect(
      (await f.caches.get(received.id)?.getInfo())
        ?.isShared,
    ).toBe(false);
    expect(
      (await f.repository.reference(received.id))
        ?.sharedReference,
    ).toBeUndefined();
    expect(await f.library.sharedFiles()).toEqual([]);
  });
});
