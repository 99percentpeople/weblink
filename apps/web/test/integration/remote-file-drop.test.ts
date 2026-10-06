// @vitest-environment node
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RemoteFileDrop } from "@/libs/application/remote-file-drop";
import { CLIPBOARD_CHUNK_SIZE } from "@/libs/domain/protocol/clipboard";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { TransferRegistry } from "@/libs/application/transfer/transfer-registry";
import type { PeerSession } from "@/libs/domain/session";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import type { PlatformRuntime } from "@weblink/platform";
import {
  FakeRtcTransport,
  deferred,
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
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((stop) => stop()));
const target = {
  sourceId: "screen",
  mediaId: "media",
  geometryRevision: "geometry",
};
function setup() {
  let maxFileBytes = 64 * 1024 * 1024;
  let enabled = true,
    grant = "grant";
  const native = {
    prepare: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const clipboard = { write: vi.fn() };
  const control = Object.assign(new EventTarget(), {
    fileDropTarget: () => ({ grantId: grant, target }),
    input: vi.fn(),
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
    const service = new RemoteFileDrop({
      platform: (i === 1
        ? { fileDrop: native, clipboard }
        : { clipboard }) as unknown as PlatformRuntime,
      host: {
        clipboardScope: (clientId, grantId) => {
          if (grantId !== grant) throw new Error("revoked");
          return { ownerId: "owner", clientId, grantId };
        },
      },
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
      enabled: () => i === 0 && enabled,
      maxFileBytes: () => (i === 0 ? maxFileBytes : 1),
      getSession: (id) =>
        id === session.targetClientId ? session : undefined,
    });
    stops.push(() => {
      service.dispose();
      protocol.dispose();
      registry.clear();
    });
    return {
      transport,
      protocol,
      session,
      registry,
      service,
      caches,
    };
  });
  for (const [i, side] of sides.entries()) {
    const other = sides[1 - i];
    side.transport.sendImpl = (_s, message) => {
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
    a: sides[0],
    b: sides[1],
    native,
    clipboard,
    control,
    limit: (bytes: number) => {
      maxFileBytes = bytes;
    },
    disable: () => {
      enabled = false;
      sides.forEach((s) => s.service.syncPermissions());
    },
    revoke: () => {
      grant = "next";
      control.dispatchEvent(new Event("change"));
      sides.forEach((s) => s.service.syncPermissions());
    },
  };
}
const point = { x: 0.25, y: 0.75 };
const files = () =>
  Promise.resolve([
    new File(
      [new Uint8Array(CLIPBOARD_CHUNK_SIZE + 13).fill(42)],
      "test.bin",
    ),
  ]);
describe("native remote file drop", () => {
  it("rejects total file bytes over the configured limit before opening a transfer", async () => {
    const s = setup();
    s.limit(5);
    await expect(
      s.a.service.drop(
        "peer1",
        s.control,
        point,
        async () => [
          new File(["abc"], "a"),
          new File(["def"], "b"),
        ],
      ),
    ).rejects.toThrow("MiB limit");
    expect(s.native.apply).not.toHaveBeenCalled();
    expect(s.a.caches.size).toBe(0);
    expect(s.b.caches.size).toBe(0);
  });
  it("snapshots the controller limit for preparation and native staging, including a raised limit", async () => {
    const s = setup();
    const limit = 128 * 1024 * 1024;
    s.limit(limit);
    const ready = deferred<File[]>();
    const read = vi.fn(
      (_signal: AbortSignal, budget: number) => {
        expect(budget).toBe(limit);
        return ready.promise;
      },
    );
    const op = s.a.service.drop(
      "peer1",
      s.control,
      point,
      read,
    );
    s.limit(1);
    ready.resolve([new File(["abcd"], "a")]);
    await op;
    expect(s.native.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      target,
      point,
      limit,
    );
    expect(s.native.apply).toHaveBeenCalledOnce();
  });
  it("reuses file channels and applies real files without clipboard or input shortcuts; only controller enables it", async () => {
    const s = setup();
    const read = vi.fn(files);
    const operation = s.a.service.drop(
      "peer1",
      s.control,
      point,
      read,
    );
    expect(read).toHaveBeenCalledOnce();
    await operation;
    expect(s.native.prepare).toHaveBeenCalledWith(
      {
        ownerId: "owner",
        clientId: "peer0",
        grantId: "grant",
      },
      expect.any(String),
      target,
      point,
      64 * 1024 * 1024,
    );
    expect(s.native.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      [
        {
          name: "test.bin",
          data: Buffer.alloc(
            CLIPBOARD_CHUNK_SIZE + 13,
            42,
          ).toString("base64"),
        },
      ],
    );
    expect(s.clipboard.write).not.toHaveBeenCalled();
    expect(s.control.input).not.toHaveBeenCalled();
    expect(s.a.service.tasks()[0]).toMatchObject({
      origin: "drop",
      status: "completed",
    });
    expect(s.b.service.tasks()[0].status).toBe("completed");
    for (const side of [s.a, s.b])
      for (const cache of side.caches.values())
        expect(cache.cleanup).toHaveBeenCalled();
  });
  it("does not complete until the native target accepts the drop", async () => {
    const s = setup(),
      accepted = deferred<void>();
    s.native.apply.mockImplementation(
      () => accepted.promise,
    );
    const done = s.a.service.drop(
      "peer1",
      s.control,
      point,
      files,
    );
    await vi.waitFor(() =>
      expect(s.native.apply).toHaveBeenCalledOnce(),
    );
    expect(s.a.service.tasks()[0].status).toBe(
      "finalizing",
    );
    expect(s.b.service.tasks()[0].status).toBe(
      "finalizing",
    );
    accepted.resolve();
    await done;
    expect(s.a.service.tasks()[0].status).toBe("completed");
  });
  it("reports native refusal as failure on both peers", async () => {
    const s = setup();
    s.native.apply.mockRejectedValue(
      new Error("Target refused"),
    );
    await expect(
      s.a.service.drop("peer1", s.control, point, files),
    ).rejects.toThrow();
    expect(s.a.service.tasks()[0]).toMatchObject({
      status: "failed",
      error: "Target refused",
    });
    expect(s.b.service.tasks()[0]).toMatchObject({
      status: "failed",
      error: "Target refused",
    });
  });
  it.each(["disable", "revoke"] as const)(
    "cancels a prepared target on %s and never applies late files",
    async (action) => {
      const s = setup(),
        read = deferred<File[]>();
      const done = s.a.service.drop(
        "peer1",
        s.control,
        point,
        () => read.promise,
      );
      const rejected = expect(done).rejects.toThrow();
      await vi.waitFor(() =>
        expect(s.native.prepare).toHaveBeenCalledOnce(),
      );
      s[action]();
      read.resolve(await files());
      await rejected;
      await vi.waitFor(() =>
        expect(s.native.cancel).toHaveBeenCalled(),
      );
      expect(s.native.apply).not.toHaveBeenCalled();
    },
  );
  it("cleans up a native prepare that finishes after cancellation", async () => {
    const s = setup(),
      prepared = deferred<void>(),
      life = new AbortController();
    s.native.prepare.mockImplementation(
      () => prepared.promise,
    );
    const done = s.a.service.drop(
      "peer1",
      s.control,
      point,
      files,
      life.signal,
    );
    const rejected = expect(done).rejects.toThrow();
    await vi.waitFor(() =>
      expect(s.native.prepare).toHaveBeenCalledOnce(),
    );
    life.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(s.native.cancel).toHaveBeenCalled(),
    );
    s.native.cancel.mockClear();
    prepared.resolve();
    await vi.waitFor(() =>
      expect(s.native.cancel).toHaveBeenCalled(),
    );
    expect(s.native.apply).not.toHaveBeenCalled();
  });
  it("propagates task cancellation to the native operation", async () => {
    const s = setup(),
      accepted = deferred<void>();
    s.native.apply.mockImplementation(
      () => accepted.promise,
    );
    const done = s.a.service.drop(
      "peer1",
      s.control,
      point,
      files,
    );
    const rejected = expect(done).rejects.toThrow();
    await vi.waitFor(() =>
      expect(s.native.apply).toHaveBeenCalled(),
    );
    await s.a.service.tasks()[0].cancel();
    await rejected;
    await vi.waitFor(() =>
      expect(s.native.cancel).toHaveBeenCalled(),
    );
    accepted.resolve();
    expect(s.a.service.tasks()[0].status).toBe("cancelled");
  });
  it("rejects unsolicited offers and replayed preparations", async () => {
    const s = setup(),
      request = {
        grantId: "grant",
        operationId: crypto.randomUUID(),
      };
    await expect(
      s.a.protocol.call(
        s.a.session,
        "remote-file-drop",
        { ...request, action: "offer", size: 100 },
        { retries: 0 },
      ),
    ).rejects.toThrow();
    expect(s.b.caches.size).toBe(0);
    await s.a.protocol.call(
      s.a.session,
      "remote-file-drop",
      {
        ...request,
        action: "prepare",
        destination: target,
        point,
      },
      { retries: 0 },
    );
    await s.a.protocol.call(
      s.a.session,
      "remote-file-drop",
      { ...request, action: "cancel" },
      { retries: 0 },
    );
    await expect(
      s.a.protocol.call(
        s.a.session,
        "remote-file-drop",
        {
          ...request,
          action: "prepare",
          destination: target,
          point,
        },
        { retries: 0 },
      ),
    ).rejects.toThrow();
    expect(s.native.prepare).toHaveBeenCalledOnce();
  });
  it("keeps single-chunk drops out of the task list", async () => {
    const s = setup(),
      prepared = vi.fn();
    await s.a.service.drop(
      "peer1",
      s.control,
      point,
      async () => [new File(["hello"], "hello.txt")],
      undefined,
      prepared,
    );
    expect(prepared).toHaveBeenCalledWith(false);
    expect(s.a.service.tasks()).toEqual([]);
  });
});
