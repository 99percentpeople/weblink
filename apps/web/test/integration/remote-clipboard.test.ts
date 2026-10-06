// @vitest-environment node
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RemoteClipboard } from "@/libs/application/remote-clipboard";
import {
  packClipboard,
  toNativeClipboard,
  type ClipboardContent,
} from "@/libs/application/clipboard-content";
import { CLIPBOARD_CHUNK_SIZE } from "@/libs/domain/protocol/clipboard";
import type { ClipboardFileDestination } from "@/libs/domain/remote-control/keyboard-options";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { TransferRegistry } from "@/libs/application/transfer/transfer-registry";
import type { PeerSession } from "@/libs/domain/session";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import type {
  PlatformRuntime,
  ClipboardEntry,
  ClipboardScope,
} from "@weblink/platform";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "../support/rtc-transport";
import {
  fakeCache,
  fakeChannel,
  FakeTransfer,
} from "../support/file-transfer";
vi.mock("@/libs/utils/process-file", () => ({
  compressFiles: vi.fn(),
  handleDropItems: vi.fn(),
}));
const disposers: (() => void)[] = [];
afterEach(() =>
  disposers.splice(0).forEach((stop) => stop()),
);
function setup() {
  let maxFileBytes = 64 * 1024 * 1024;
  let destination: ClipboardFileDestination = "clipboard";
  const cacheFile = vi.fn(
    async (_file: File, _signal: AbortSignal) => {},
  );
  let hostEnabled = false;
  let enabled = true,
    grant = "grant",
    epoch = "epoch";
  const applied = deferred<void>();
  const events: string[] = [];
  let nativeChanged: (() => void) | undefined;
  const native = {
    sequence: vi.fn(async () => 7),
    read: vi.fn(
      async (): Promise<{
        sequence: number;
        entries: ClipboardEntry[];
      }> => ({
        sequence: 8,
        entries: [
          {
            type: "text/plain" as const,
            data: btoa("remote text"),
          },
        ],
      }),
    ),
    write: vi.fn(
      async (
        _entries: ClipboardEntry[],
        _scope?: ClipboardScope,
      ) => {
        events.push("write");
        await applied.promise;
        events.push("applied");
        return 9;
      },
    ),
    watch: vi.fn(async (_scope, changed) => {
      nativeChanged = changed;
      return () => {
        nativeChanged = undefined;
      };
    }),
  };
  const host = {
    clipboardScope: vi.fn((clientId, grantId) => {
      if (grantId !== grant) throw new Error("revoked");
      return { ownerId: "owner", clientId, grantId };
    }),
  };
  const control = Object.assign(new EventTarget(), {
    state: () => "active",
    clipboardGrant: () => grant,
    clipboardEpoch: () => epoch,
    input: vi.fn((event) => {
      if (event.down && event.scanCode === 0x2f)
        events.push("paste");
      return true;
    }),
    cancel: vi.fn(),
  }) as unknown as RemotePointer;
  const sides = [0, 1].map((i) => {
    const transport = new FakeRtcTransport();
    const protocol = new P2PProtocol(transport);
    const session = {
      clientId: `peer${i}`,
      targetClientId: `peer${1 - i}`,
      isMessageChannelReady: true,
    } as PeerSession;
    const caches = new Map<
      string,
      ReturnType<typeof fakeCache>
    >();
    const registry = new TransferRegistry({
      createTransfer: ({ cache, mode }) =>
        new FakeTransfer(cache, mode),
      publish: () => {},
      bind: () => {},
      complete: async () => {},
      failed: () => {},
      automaticCacheDeletion: () => false,
      reportError: () => {},
    });
    const service = new RemoteClipboard({
      platform: (i === 1
        ? { clipboard: native }
        : {}) as unknown as PlatformRuntime,
      host,
      protocol,
      rtc: transport,
      registry,
      caches: {
        temporaryTransferCache: async (id) => {
          const cache = fakeCache(id);
          caches.set(id, cache);
          return cache;
        },
      },
      fileDestination: () => destination,
      maxFileBytes: () => (i === 0 ? maxFileBytes : 1),
      cacheFile,
      enabled: () => (i === 0 ? enabled : hostEnabled),
      getSession: (id) =>
        id === session.targetClientId ? session : undefined,
    });
    disposers.push(() => {
      service.dispose();
      protocol.dispose();
      registry.clear();
    });
    return {
      transport,
      protocol,
      session,
      caches,
      registry,
      service,
    };
  });
  for (const [index, side] of sides.entries()) {
    const other = sides[1 - index];
    side.transport.sendImpl = (_session, message) => {
      void other.transport.emit(other.session, message);
    };
    side.session.createChannel = vi.fn(
      async (label: string) => {
        const id = label.slice(0, -2);
        const sender = other.registry.get(
          other.session,
          id,
        )!;
        const receiver = side.registry.get(
          side.session,
          id,
        )!;
        (
          sender.transferer as FakeTransfer
        ).sendFile.mockImplementation(async () => {
          const file =
            await sender.transferer.cache.getFile();
          const info =
            (await receiver.transferer.cache.getInfo())!;
          await receiver.transferer.cache.setInfo({
            ...info,
            file: file!,
          });
          (sender.transferer as FakeTransfer).finish();
          (receiver.transferer as FakeTransfer).finish();
        });
        other.registry.setChannel(
          sender,
          fakeChannel(label),
        );
        return fakeChannel(label);
      },
    );
  }
  return {
    cacheFile,
    limit: (bytes: number) => {
      maxFileBytes = bytes;
    },
    destination: (next: ClipboardFileDestination) => {
      destination = next;
      sides[0].service.syncPermissions();
    },
    a: sides[0],
    b: sides[1],
    native,
    control,
    events,
    applied,
    changed: () => nativeChanged?.(),
    hostEnabled: (value: boolean) => {
      hostEnabled = value;
      sides[1].service.syncPermissions();
    },
    disable: () => {
      enabled = false;
      sides.forEach((s) => s.service.syncPermissions());
    },
    revoke: () => {
      grant = "new-grant";
      control.dispatchEvent(new Event("change"));
      sides.forEach((s) => s.service.syncPermissions());
    },
    blur: () => {
      epoch = "new-epoch";
      control.dispatchEvent(new Event("change"));
    },
  };
}
describe("authorized remote clipboard", () => {
  it.each([true, false])(
    "enforces the controller file budget on remote copy (selection=%s)",
    async (selection) => {
      const s = setup();
      s.limit(5);
      s.native.read.mockResolvedValue({
        sequence: 8,
        entries: [
          { type: "file", name: "a", data: btoa("abc") },
          { type: "file", name: "b", data: btoa("def") },
        ],
      });
      await expect(
        s.a.service.copy("peer1", s.control, selection),
      ).rejects.toThrow("MiB limit");
      expect(s.native.read).toHaveBeenCalledWith(
        expect.anything(),
        selection ? 7 : undefined,
        true,
        5,
      );
      expect(s.a.caches.size).toBe(0);
      expect(s.b.caches.size).toBe(0);
    },
  );
  it("rejects oversized paste before transferring and does not limit text with the file preference", async () => {
    const s = setup();
    s.limit(3);
    await expect(
      s.a.service.paste("peer1", s.control, [
        {
          type: "file",
          name: "a",
          blob: new Blob(["abcd"]),
        },
      ]),
    ).rejects.toThrow("MiB limit");
    expect(s.native.write).not.toHaveBeenCalled();
    expect(s.a.caches.size).toBe(0);
    s.applied.resolve();
    await s.a.service.paste("peer1", s.control, [
      {
        type: "text/plain",
        blob: new Blob(["longer text"]),
      },
    ]);
    expect(s.native.write).toHaveBeenCalledOnce();
  });
  it("snapshots a raised controller file limit for both copy and paste, ignoring the host preference", async () => {
    const s = setup();
    const limit = 128 * 1024 * 1024;
    s.limit(limit);
    const ready = deferred<{
      sequence: number;
      entries: ClipboardEntry[];
    }>();
    s.native.read.mockImplementation(() => ready.promise);
    const copy = s.a.service.copy("peer1", s.control);
    s.limit(1);
    ready.resolve({
      sequence: 8,
      entries: [
        { type: "file", name: "a", data: btoa("abcd") },
      ],
    });
    const content = await copy;
    expect(s.native.read).toHaveBeenCalledWith(
      expect.anything(),
      7,
      true,
      limit,
    );
    s.limit(limit);
    s.applied.resolve();
    await s.a.service.paste("peer1", s.control, content);
    expect(s.native.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      limit,
    );
  });
  const copiedFiles = [
    {
      type: "file" as const,
      name: "data.bin",
      data: btoa("x".repeat(CLIPBOARD_CHUNK_SIZE + 1)),
    },
  ];
  it("imports copied files into file cache and keeps the task active until storage completes", async () => {
    const s = setup();
    s.destination("cache");
    s.native.read.mockResolvedValue({
      sequence: 8,
      entries: copiedFiles,
    });
    const stored = deferred<void>();
    s.cacheFile.mockImplementation(
      async () => stored.promise,
    );
    const receive = vi.fn(async () => {});
    const operation = s.a.service.copy(
      "peer1",
      s.control,
      true,
      { receive },
    );
    await vi.waitFor(() =>
      expect(s.cacheFile).toHaveBeenCalledOnce(),
    );
    expect(s.a.service.tasks()[0].status).toBe(
      "finalizing",
    );
    expect(s.cacheFile.mock.calls[0][0].name).toBe(
      "data.bin",
    );
    expect(s.cacheFile.mock.calls[0][0].size).toBe(
      CLIPBOARD_CHUNK_SIZE + 1,
    );
    s.blur();
    expect(s.cacheFile.mock.calls[0][1].aborted).toBe(
      false,
    );
    expect(s.a.service.tasks()[0].status).toBe(
      "finalizing",
    );
    stored.resolve();
    expect(await operation).toEqual([]);
    expect(receive).toHaveBeenCalledWith(
      [],
      expect.any(AbortSignal),
    );
    expect(s.a.service.tasks()[0].status).toBe("completed");
    expect(s.native.write).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "keeps an authorized copy alive across a focus reset while reading (selection: %s)",
    async (selection) => {
      const s = setup();
      s.destination("cache");
      const snapshot = deferred<{
        sequence: number;
        entries: ClipboardEntry[];
      }>();
      s.native.read.mockReturnValue(snapshot.promise);
      const operation = s.a.service.copy(
        "peer1",
        s.control,
        selection,
      );
      await vi.waitFor(() =>
        expect(s.native.read).toHaveBeenCalledOnce(),
      );
      const inputCount = vi.mocked(s.control.input).mock
        .calls.length;
      s.blur();
      snapshot.resolve({
        sequence: 8,
        entries: copiedFiles,
      });
      expect(await operation).toEqual([]);
      expect(s.cacheFile).toHaveBeenCalledOnce();
      expect(s.control.input).toHaveBeenCalledTimes(
        inputCount,
      );
      for (const side of [s.a, s.b])
        expect(side.service.tasks()[0].status).toBe(
          "completed",
        );
    },
  );
  it("does not inject Ctrl+C after a focus reset while preparing the copy", async () => {
    const s = setup();
    const sequence = deferred<number>();
    s.native.sequence.mockReturnValue(sequence.promise);
    const operation = s.a.service.copy("peer1", s.control);
    const failure = expect(operation).rejects.toThrow();
    await vi.waitFor(() =>
      expect(s.native.sequence).toHaveBeenCalledOnce(),
    );
    s.blur();
    sequence.resolve(7);
    await failure;
    await flushRtc();
    expect(s.control.input).not.toHaveBeenCalled();
    expect(s.native.read).not.toHaveBeenCalled();
  });
  it("excludes disabled files at the native read boundary without opening a transfer or cache", async () => {
    const s = setup();
    s.destination("off");
    s.native.read.mockResolvedValue({
      sequence: 8,
      entries: copiedFiles,
    });
    expect(
      await s.a.service.copy("peer1", s.control),
    ).toEqual([]);
    expect(s.native.read).toHaveBeenCalledWith(
      expect.anything(),
      7,
      false,
      64 * 1024 * 1024,
    );
    expect(s.cacheFile).not.toHaveBeenCalled();
    expect(s.a.caches.size).toBe(0);
    expect(s.b.caches.size).toBe(0);
    expect(s.a.service.tasks()).toEqual([]);
    expect(s.b.service.tasks()).toEqual([]);
  });
  it("keeps text and images available while copying files is disabled", async () => {
    const s = setup();
    s.destination("off");
    s.native.read.mockResolvedValue({
      sequence: 8,
      entries: [
        ...copiedFiles,
        { type: "text/plain", data: btoa("text") },
        { type: "image/png", data: btoa("image") },
      ],
    });
    const content = await s.a.service.copy(
      "peer1",
      s.control,
    );
    expect(content.map((entry) => entry.type)).toEqual([
      "text/plain",
      "image/png",
    ]);
    expect(s.cacheFile).not.toHaveBeenCalled();
  });
  it("does not mark a file copy complete when the controller clipboard write fails", async () => {
    const s = setup();
    s.native.read.mockResolvedValue({
      sequence: 8,
      entries: copiedFiles,
    });
    const writing = deferred<void>();
    const receive = vi.fn(async () => writing.promise);
    const operation = s.a.service.copy(
      "peer1",
      s.control,
      true,
      { receive },
    );
    const failure =
      expect(operation).rejects.toThrow("write denied");
    await vi.waitFor(() =>
      expect(receive).toHaveBeenCalledOnce(),
    );
    expect(s.a.service.tasks()[0].status).toBe(
      "finalizing",
    );
    writing.reject(new Error("write denied"));
    await failure;
    expect(s.a.service.tasks()[0].status).toBe("failed");
  });
  it.each([
    "destination",
    "disable",
    "revoke",
    "disconnect",
    "cancel",
  ] as const)(
    "cancels a pending copy import after %s",
    async (action) => {
      const s = setup();
      s.destination("cache");
      s.native.read.mockResolvedValue({
        sequence: 8,
        entries: copiedFiles,
      });
      const stored = deferred<void>();
      s.cacheFile.mockImplementation(
        async () => stored.promise,
      );
      const receive = vi.fn(async () => {});
      const operation = s.a.service.copy(
        "peer1",
        s.control,
        false,
        { receive },
      );
      const failure = expect(operation).rejects.toThrow();
      await vi.waitFor(() =>
        expect(s.cacheFile).toHaveBeenCalledOnce(),
      );
      s.blur();
      if (action === "destination") s.destination("off");
      else if (action === "disconnect")
        s.a.transport.close(s.a.session);
      else if (action === "cancel")
        await s.a.service.tasks()[0].cancel();
      else s[action]();
      expect(s.cacheFile.mock.calls[0][1].aborted).toBe(
        true,
      );
      stored.resolve();
      await failure;
      expect(receive).not.toHaveBeenCalled();
      expect(s.a.service.tasks()[0].status).toBe(
        "cancelled",
      );
    },
  );
  it("synchronizes text without a task and waits for native application before Ctrl+V", async () => {
    const s = setup();
    const operation = s.a.service.paste(
      "peer1",
      s.control,
      [
        {
          type: "text/plain",
          blob: new Blob(["hello\nworld"]),
        },
      ],
    );
    await vi.waitFor(() =>
      expect(s.native.write).toHaveBeenCalledOnce(),
    );
    expect(s.events).toEqual(["write"]);
    expect(s.a.service.tasks()).toEqual([]);
    expect(s.b.service.tasks()).toEqual([]);
    s.applied.resolve();
    await operation;
    expect(s.events).toEqual(["write", "applied", "paste"]);
    expect(s.native.write.mock.calls[0][0]).toEqual([
      {
        type: "text/plain",
        data: btoa("hello\nworld"),
        name: undefined,
      },
    ]);
    for (const side of [s.a, s.b]) {
      expect(side.service.tasks()).toEqual([]);
      for (const cache of side.caches.values())
        expect(cache.cleanup).toHaveBeenCalled();
    }
  });
  it.each([
    ["text/plain", CLIPBOARD_CHUNK_SIZE * 2, false],
    ["text/html", CLIPBOARD_CHUNK_SIZE * 2, false],
    ["text/rtf", CLIPBOARD_CHUNK_SIZE * 2, false],
    ["file", CLIPBOARD_CHUNK_SIZE, false],
    ["file", CLIPBOARD_CHUNK_SIZE + 1, true],
    ["image/png", CLIPBOARD_CHUNK_SIZE, false],
    ["image/png", CLIPBOARD_CHUNK_SIZE + 1, true],
  ] as const)(
    "%s bundle of %i bytes creates tasks: %s, for both copy and paste",
    async (type, size, tracked) => {
      const s = setup();
      const content: ClipboardContent = [
        {
          type,
          name: type === "file" ? "data.txt" : undefined,
          blob: new Blob([]),
        },
      ];
      // Match the actual packed boundary, including the manifest and header.
      let payloadSize = size;
      for (let i = 0; i < 4; i++) {
        content[0].blob = new Blob([
          "x".repeat(payloadSize),
        ]);
        payloadSize +=
          size - (await packClipboard(content)).size;
      }
      expect((await packClipboard(content)).size).toBe(
        size,
      );
      s.native.read.mockResolvedValue({
        sequence: 8,
        entries: await toNativeClipboard(content),
      });
      const copied = await s.a.service.copy(
        "peer1",
        s.control,
      );
      expect(copied[0].blob.size).toBe(
        content[0].blob.size,
      );
      for (const side of [s.a, s.b]) {
        expect(side.service.tasks()).toHaveLength(
          tracked ? 1 : 0,
        );
        if (tracked)
          expect(side.service.tasks()[0].status).toBe(
            "completed",
          );
        side.service.clearFinished();
      }
      const operation = s.a.service.paste(
        "peer1",
        s.control,
        content,
      );
      await vi.waitFor(() =>
        expect(s.native.write).toHaveBeenCalledOnce(),
      );
      for (const side of [s.a, s.b]) {
        expect(side.service.tasks()).toHaveLength(
          tracked ? 1 : 0,
        );
        if (tracked)
          expect(side.service.tasks()[0].status).toBe(
            "finalizing",
          );
      }
      s.applied.resolve();
      await operation;
      for (const side of [s.a, s.b]) {
        expect(side.service.tasks()).toHaveLength(
          tracked ? 1 : 0,
        );
        if (tracked)
          expect(side.service.tasks()[0].status).toBe(
            "completed",
          );
        for (const cache of side.caches.values())
          expect(cache.cleanup).toHaveBeenCalled();
      }
    },
  );
  it("samples the clipboard before Ctrl+C and waits for new remote content", async () => {
    const s = setup();
    const result = await s.a.service.copy(
      "peer1",
      s.control,
    );
    expect(await result[0].blob.text()).toBe("remote text");
    expect(s.native.read).toHaveBeenCalledWith(
      {
        ownerId: "owner",
        clientId: "peer0",
        grantId: "grant",
      },
      7,
      true,
      64 * 1024 * 1024,
    );
    expect(s.control.input).toHaveBeenCalledWith({
      type: "key",
      scanCode: 0x2e,
      extended: false,
      down: true,
    });
    expect(s.native.write).not.toHaveBeenCalled();
  });
  it("cancels a clipboard file task before sending the final paste shortcut", async () => {
    const s = setup();
    const operation = s.a.service.paste(
      "peer1",
      s.control,
      [
        {
          type: "file",
          name: "data.txt",
          blob: new Blob([
            "x".repeat(CLIPBOARD_CHUNK_SIZE + 1),
          ]),
        },
      ],
    );
    const failure = expect(operation).rejects.toThrow();
    await vi.waitFor(() =>
      expect(s.native.write).toHaveBeenCalledOnce(),
    );
    const task = s.a.service.tasks()[0];
    expect(task.origin).toBe("clipboard");
    await task.cancel();
    expect(s.a.service.tasks()[0].status).toBe("cancelled");
    s.applied.resolve();
    await failure;
    await flushRtc();
    expect(s.events).not.toContain("paste");
  });
  it.each(["disable", "revoke", "blur"] as const)(
    "does not inject paste after %s while native write is pending",
    async (action) => {
      const s = setup();
      const operation = s.a.service.paste(
        "peer1",
        s.control,
        [{ type: "text/plain", blob: new Blob(["x"]) }],
      );
      const failure = expect(operation).rejects.toThrow();
      await vi.waitFor(() =>
        expect(s.native.write).toHaveBeenCalledOnce(),
      );
      s[action]();
      s.applied.resolve();
      await failure;
      await flushRtc();
      expect(s.events).not.toContain("paste");
    },
  );
  it("rejects unsolicited clipboard data before opening a cache", async () => {
    const s = setup();
    await expect(
      s.b.protocol.call(s.b.session, "remote-clipboard", {
        action: "offer",
        direction: "copy",
        operationId: "unknown",
        grantId: "grant",
        size: 20,
        kind: "text",
      }),
    ).rejects.toThrow("Unsolicited");
    expect(s.a.caches.size).toBe(0);
  });
  it("binds context-menu notifications to their watcher and stops on disable", async () => {
    const s = setup();
    const changed = vi.fn();
    const stop = s.a.service.watch(
      "peer1",
      s.control,
      changed,
    );
    await vi.waitFor(() =>
      expect(s.native.watch).toHaveBeenCalledOnce(),
    );
    s.changed();
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledOnce(),
    );
    s.disable();
    s.changed();
    await flushRtc();
    expect(changed).toHaveBeenCalledOnce();
    stop();
  });
  it("host controller preferences do not interrupt clipboard serving; revocation still does", async () => {
    const s = setup();
    const changed = vi.fn();
    s.a.service.watch("peer1", s.control, changed);
    await vi.waitFor(() =>
      expect(s.native.watch).toHaveBeenCalledOnce(),
    );
    s.hostEnabled(true);
    s.hostEnabled(false);
    s.changed();
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledOnce(),
    );
    s.revoke();
    s.changed();
    await flushRtc();
    expect(changed).toHaveBeenCalledOnce();
  });
  it("does not resume after disconnect with the same peer identity", async () => {
    const s = setup();
    const input =
      deferred<[{ type: "text/plain"; blob: Blob }]>();
    const pending = s.a.service.paste(
      "peer1",
      s.control,
      input.promise,
    );
    const failure = expect(pending).rejects.toThrow();
    s.a.transport.close(s.a.session);
    input.resolve([
      { type: "text/plain", blob: new Blob(["secret"]) },
    ]);
    await failure;
    expect(s.native.write).not.toHaveBeenCalled();
    expect(s.a.caches.size).toBe(0);
  });
});
