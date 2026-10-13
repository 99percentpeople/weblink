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
import type {
  PlatformRuntime,
  NativeFileDrop,
} from "@weblink/platform";
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
  let supportsHover = true;
  let maxFileBytes = 64 * 1024 * 1024;
  let enabled = true,
    grant = "grant";
  const native = {
    hover: vi.fn<NonNullable<NativeFileDrop["hover"]>>(
      async () => {},
    ),
    prepare: vi.fn<NativeFileDrop["prepare"]>(
      async () => {},
    ),
    apply: vi.fn<NativeFileDrop["apply"]>(async () => {}),
    cancel: vi.fn<NativeFileDrop["cancel"]>(async () => {}),
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
      supportsHover: () => supportsHover,
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
    legacy: () => {
      supportsHover = false;
    },
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
  it("reports hover startup failures before the controller releases the files", async () => {
    const s = setup();
    s.native.hover.mockRejectedValue(
      "Could not start native file drag",
    );
    await expect(
      s.a.service.hover("peer1", s.control, point, []),
    ).rejects.toThrow("Could not start native file drag");
    expect(s.native.prepare).not.toHaveBeenCalled();
    expect(s.native.apply).not.toHaveBeenCalled();
  });
  it.each(["prepare", "apply"] as const)(
    "preserves the native %s error when cancellation arrives before the reply",
    async (phase) => {
      const s = setup();
      s.native[phase].mockRejectedValue(
        "Native file drag ended: cursor moved",
      );
      await expect(
        s.a.service.drop("peer1", s.control, point, files),
      ).rejects.toThrow(
        "Native file drag ended: cursor moved",
      );
    },
  );
  it("forwards hover before transferring files and only applies after a real drop", async () => {
    const s = setup();
    s.a.service.hover("peer1", s.control, point, [
      "image/png",
    ]);
    await vi.waitFor(() =>
      expect(s.native.hover).toHaveBeenCalledOnce(),
    );
    expect(s.native.prepare).not.toHaveBeenCalled();
    expect(s.native.apply).not.toHaveBeenCalled();
    expect(s.a.caches.size).toBe(0);
    const moved = { x: 0.4, y: 0.6 };
    s.a.service.hover("peer1", s.control, moved, [
      "image/png",
    ]);
    const read = vi.fn(files);
    const done = s.a.service.drop(
      "peer1",
      s.control,
      moved,
      read,
    );
    expect(read).toHaveBeenCalledOnce();
    // The browser's dragend after a drop must not cancel the transfer.
    s.a.service.leave("peer1", s.control);
    await done;
    expect(s.native.prepare.mock.calls[0][1]).toBe(
      s.native.hover.mock.calls[0][1],
    );
    expect(s.native.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      target,
      moved,
      64 * 1024 * 1024,
    );
    expect(s.native.apply).toHaveBeenCalledOnce();
  });
  it("coalesces hover updates and cancels on leave without importing preview files", async () => {
    const s = setup(),
      ready = deferred<void>();
    s.native.hover.mockImplementationOnce(
      () => ready.promise,
    );
    s.a.service.hover("peer1", s.control, point, [
      "image/png",
    ]);
    await vi.waitFor(() =>
      expect(s.native.hover).toHaveBeenCalledOnce(),
    );
    for (let i = 1; i <= 10; i++)
      s.a.service.hover(
        "peer1",
        s.control,
        { x: i / 10, y: 0.5 },
        ["image/png"],
      );
    expect(s.native.hover).toHaveBeenCalledOnce();
    ready.resolve();
    await vi.waitFor(() =>
      expect(s.native.hover).toHaveBeenCalledTimes(2),
    );
    expect(s.native.hover).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      target,
      { x: 1, y: 0.5 },
      ["image/png"],
    );
    s.a.service.leave("peer1", s.control);
    await vi.waitFor(() =>
      expect(s.native.cancel).toHaveBeenCalled(),
    );
    expect(s.native.apply).not.toHaveBeenCalled();
    expect(s.a.service.tasks()).toEqual([]);
  });
  it("retires delayed hover initialization before a replacement native drag starts", async () => {
    const s = setup(),
      ready = deferred<void>();
    s.native.hover.mockImplementationOnce(
      () => ready.promise,
    );
    s.a.service.hover("peer1", s.control, point, []);
    await vi.waitFor(() =>
      expect(s.native.hover).toHaveBeenCalledOnce(),
    );
    s.a.service.leave("peer1", s.control);
    s.a.service.hover("peer1", s.control, point, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.native.hover).toHaveBeenCalledOnce();
    ready.resolve();
    await vi.waitFor(() =>
      expect(s.native.hover).toHaveBeenCalledTimes(2),
    );
    expect(
      s.native.cancel.mock.invocationCallOrder[0],
    ).toBeLessThan(
      s.native.hover.mock.invocationCallOrder[1],
    );
    expect(s.native.apply).not.toHaveBeenCalled();
  });
  it("uses the existing drop flow for peers that do not advertise hover", async () => {
    const s = setup();
    s.legacy();
    s.a.service.hover("peer1", s.control, point, []);
    await s.a.service.drop(
      "peer1",
      s.control,
      point,
      files,
    );
    expect(s.native.hover).not.toHaveBeenCalled();
    expect(s.native.apply).toHaveBeenCalledOnce();
  });
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
