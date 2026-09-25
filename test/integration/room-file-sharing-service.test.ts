// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RoomFileSharingService } from "@/libs/application/messaging/room-file-sharing-service";
import type { RoomFileBinding } from "@/libs/application/messaging/room-messaging-service";
import type { FileTransferMessage } from "@/libs/domain/message";
import type { ChunkMetaData } from "@/libs/domain/file";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import {
  FakeRtcTransport,
  deferred,
  makeSession,
} from "../support/rtc-transport";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups.splice(0).forEach((dispose) => dispose()),
);

function setup(outgoing = false) {
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  const session = makeSession("local", "peer");
  const epoch = new AbortController();
  const binding: RoomFileBinding = {
    room: {
      roomId: "meeting",
      namespace: "test",
      conversationId: "room-conversation",
    },
    senderToken: "local-token",
    recipientToken: "remote-token",
    signal: epoch.signal,
    assertCurrent: () => {
      if (epoch.signal.aborted)
        throw new Error("Room changed");
    },
  };
  const offer: FileTransferMessage = {
    id: "offer",
    type: "file",
    fid: "file",
    fileName: "test.bin",
    fileSize: 2048,
    mimeType: "application/octet-stream",
    chunkSize: 1024,
    lastModified: 123,
    createdAt: 1000,
    client: outgoing ? "local" : "peer",
    target: outgoing ? "room-conversation" : "local",
    conversationId: "room-conversation",
    room: {
      roomId: "meeting",
      senderName: "Sender",
      senderAvatar: null,
    },
    ...(outgoing
      ? { deliveries: { peer: "delivered" as const } }
      : {}),
  };
  const info: ChunkMetaData = {
    id: "file",
    fileName: "test.bin",
    fileSize: 2048,
    chunkSize: 1024,
  };
  let scopeKey: string | null = "scope";
  const rooms = {
    get currentScopeKey() {
      return scopeKey;
    },
    get scopeSignal() {
      return epoch.signal;
    },
    sendFile: vi.fn(
      async (
        _info: ChunkMetaData,
        key: string,
        _id: string,
      ) => {
        if (key !== scopeKey)
          throw new Error("Room changed");
      },
    ),
    getFileBinding: vi.fn(async () => {
      binding.assertCurrent();
      return binding;
    }),
    validateFileBinding: vi.fn((_session, message) => {
      binding.assertCurrent();
      if (
        message.roomId !== "meeting" ||
        message.senderToken !== "remote-token" ||
        message.recipientToken !== "local-token"
      )
        throw new Error("Stale room file binding");
      return binding;
    }),
  };
  const files = {
    prepareRoomFile: vi.fn(
      async (
        _file: File,
        _origin?: { messageId: string; clientId: string },
        _signal?: AbortSignal,
      ) => info,
    ),
    receiveFileOffer: vi.fn(
      async (_session, _info, options) =>
        options.request([1], options.signal),
    ),
    serveFileOffer: vi.fn(async (_session, _options) => {}),
  };
  let messages = [offer];
  const autoDownloadLimit = vi.fn(
    (_conversationId: string) => 0,
  );
  const service = new RoomFileSharingService(protocol, {
    rooms,
    files,
    getMessages: () => messages,
    getLocalClientId: () => "local",
    getSession: () => session,
    getAutoDownloadLimit: autoDownloadLimit,
  });
  transport.sendImpl = async (_, message) => {
    if (message.type === "request-room-file")
      await transport.emit(
        session,
        createSessionMessage(
          { clientId: "peer", targetClientId: "local" },
          "ack",
          { mode: "send" },
          { id: message.id },
        ),
      );
  };
  cleanups.push(() => {
    epoch.abort();
    service.dispose();
    protocol.dispose();
  });
  const pull = async (
    payload: Record<string, unknown> = {},
  ) => {
    await transport.emit(
      session,
      createSessionMessage(
        { clientId: "peer", targetClientId: "local" },
        "request-room-file",
        {
          roomId: "meeting",
          senderToken: "remote-token",
          recipientToken: "local-token",
          offerId: "offer",
          fid: "file",
          resume: true,
          ...payload,
        },
      ),
    );
  };
  return {
    service,
    autoDownloadLimit,
    transport,
    rooms,
    files,
    offer,
    session,
    epoch,
    pull,
    setScope: (value: string | null) => {
      scopeKey = value;
    },
    deleteOffer: () => {
      messages = [];
    },
  };
}

describe("room file authorization and explicit pulls", () => {
  it("publishes a selected file without requiring AbortSignal.any", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal,
      "any",
    );
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });
    try {
      const f = setup(true);
      await f.service.sendFile(
        new File(["photo"], "photo.jpg"),
      );
      expect(
        f.files.prepareRoomFile,
      ).toHaveBeenCalledOnce();
      expect(f.rooms.sendFile).toHaveBeenCalledOnce();
    } finally {
      if (descriptor)
        Object.defineProperty(
          AbortSignal,
          "any",
          descriptor,
        );
      else Reflect.deleteProperty(AbortSignal, "any");
    }
  });

  it("leaves auto-download off by default and reads the original offer's room and size", async () => {
    const f = setup();
    await f.service.autoDownloadFile(f.offer);
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
    f.autoDownloadLimit.mockReturnValue(1024);
    await f.service.autoDownloadFile({
      ...f.offer,
      fileSize: 1,
      conversationId: "another-room",
    });
    expect(f.autoDownloadLimit).toHaveBeenLastCalledWith(
      "room-conversation",
    );
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
    // Declining an automatic download must not prevent a manual request.
    await f.service.requestFile(f.offer);
    expect(f.files.receiveFileOffer).toHaveBeenCalledOnce();
  });

  it.each([
    [0, true],
    [5 * 1024 * 1024, true],
    [5 * 1024 * 1024 + 1, false],
  ])(
    "auto-downloads within the inclusive limit: %i bytes",
    async (size, expected) => {
      const f = setup();
      f.offer.fileSize = size;
      f.autoDownloadLimit.mockReturnValue(5 * 1024 * 1024);
      await f.service.autoDownloadFile(f.offer);
      expect(
        f.files.receiveFileOffer,
      ).toHaveBeenCalledTimes(expected ? 1 : 0);
    },
  );

  it("does not auto-resume existing transfers or download outgoing offers", async () => {
    const f = setup();
    f.autoDownloadLimit.mockReturnValue(5 * 1024 * 1024);
    const states: FileTransferMessage["transferStatus"][] =
      [
        "init",
        "transfering",
        "complete",
        "paused",
        "error",
      ];
    for (const status of states) {
      f.offer.transferStatus = status;
      await f.service.autoDownloadFile(f.offer);
    }
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
    const outgoing = setup(true);
    outgoing.autoDownloadLimit.mockReturnValue(
      5 * 1024 * 1024,
    );
    await outgoing.service.autoDownloadFile(outgoing.offer);
    expect(
      outgoing.files.receiveFileOffer,
    ).not.toHaveBeenCalled();
  });

  it("coalesces an automatic pull with a manual click and leaves failures manually retryable", async () => {
    const f = setup();
    f.autoDownloadLimit.mockReturnValue(5 * 1024 * 1024);
    const wait = deferred<void>();
    f.files.receiveFileOffer.mockImplementationOnce(
      () => wait.promise,
    );
    const automatic = f.service.autoDownloadFile(f.offer);
    await Promise.resolve();
    await f.service.requestFile(f.offer);
    expect(f.files.receiveFileOffer).toHaveBeenCalledOnce();
    wait.reject(new Error("Sender disconnected"));
    await expect(automatic).rejects.toThrow(
      "Sender disconnected",
    );
    await f.service.requestFile(f.offer);
    expect(f.files.receiveFileOffer).toHaveBeenCalledTimes(
      2,
    );
  });

  it("prepares only local bytes before publishing an offer, never starts a run", async () => {
    const f = setup(true);
    const wait = deferred<ChunkMetaData>();
    f.files.prepareRoomFile.mockReturnValueOnce(
      wait.promise,
    );
    const file = new File(
      [new Uint8Array([0, 255, 1])],
      "binary.bin",
    );
    const sending = f.service.sendFile(file);
    expect(f.rooms.sendFile).not.toHaveBeenCalled();
    expect(f.transport.sendCalls).toHaveLength(0);
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
    expect(f.files.serveFileOffer).not.toHaveBeenCalled();
    wait.resolve({
      id: "cached",
      fileName: file.name,
      fileSize: file.size,
      chunkSize: 1024,
    });
    await sending;
    const origin =
      f.files.prepareRoomFile.mock.calls[0][1]!;
    expect(origin.clientId).toBe("local");
    expect(f.rooms.sendFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cached" }),
      "scope",
      origin.messageId,
    );
    expect(f.files.serveFileOffer).not.toHaveBeenCalled();
  });

  it("does not publish to a new room after asynchronous file preparation", async () => {
    const f = setup(true);
    const wait = deferred<ChunkMetaData>();
    f.files.prepareRoomFile.mockReturnValueOnce(
      wait.promise,
    );
    const pending = f.service.sendFile(
      new File(["x"], "x.bin"),
    );
    f.setScope("other-room");
    wait.resolve({
      id: "cached",
      fileName: "x.bin",
      fileSize: 1,
    });
    await expect(pending).rejects.toThrow("Room changed");
    expect(f.files.serveFileOffer).not.toHaveBeenCalled();
  });

  it.each(["room", "service"])(
    "cancels file preparation when its %s closes",
    async (source) => {
      const f = setup(true);
      const wait = deferred<ChunkMetaData>();
      f.files.prepareRoomFile.mockReturnValueOnce(
        wait.promise,
      );
      const pending = f.service.sendFile(
        new File(["x"], "x.bin"),
      );
      const signal =
        f.files.prepareRoomFile.mock.calls[0][2]!;
      if (source === "room") f.epoch.abort();
      else f.service.dispose();
      expect(signal.aborted).toBe(true);
      const rejection = expect(pending).rejects.toBe(
        signal.reason,
      );
      wait.resolve({
        id: "cached",
        fileName: "x.bin",
        fileSize: 1,
      });
      await rejection;
      expect(f.rooms.sendFile).not.toHaveBeenCalled();
    },
  );

  it("waits for an explicit request and uses stored metadata with a fresh request id on resume", async () => {
    const f = setup();
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
    await f.service.requestFile({
      ...f.offer,
      fileName: "forged.bin",
      fileSize: 99,
    });
    await f.service.requestFile(f.offer);
    const requests = f.transport.sendCalls
      .map(({ message }) => message)
      .filter(
        (message) => message.type === "request-room-file",
      );
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map(({ id }) => id)).size).toBe(
      2,
    );
    expect(requests.every(({ id }) => id !== "offer")).toBe(
      true,
    );
    expect(requests[0]).toMatchObject({
      offerId: "offer",
      fid: "file",
      ranges: [1],
      resume: true,
    });
    expect(requests[0]).not.toHaveProperty("fileSize");
    expect(f.files.receiveFileOffer).toHaveBeenCalledWith(
      f.session,
      expect.objectContaining({
        fileName: "test.bin",
        fileSize: 2048,
        from: "peer",
        roomOfferId: "offer",
        roomAttachment: true,
      }),
      expect.objectContaining({
        messageId: "offer",
        signal: f.epoch.signal,
      }),
    );
  });

  it("coalesces double clicks until setup finishes", async () => {
    const f = setup();
    const wait = deferred<void>();
    f.files.receiveFileOffer.mockImplementationOnce(
      async () => wait.promise,
    );
    const first = f.service.requestFile(f.offer);
    await Promise.resolve();
    await f.service.requestFile(f.offer);
    expect(f.files.receiveFileOffer).toHaveBeenCalledTimes(
      1,
    );
    wait.resolve();
    await first;
  });

  it("authorizes only the original recipient, using original metadata and offer identity", async () => {
    const f = setup(true);
    await f.pull({ ranges: [[0, 1]] });
    expect(f.files.serveFileOffer).toHaveBeenCalledWith(
      f.session,
      expect.objectContaining({
        messageId: "offer",
        fid: "file",
        ranges: [[0, 1]],
        info: expect.objectContaining({
          fileSize: 2048,
          roomOfferId: "offer",
          from: "local",
        }),
      }),
    );
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({ type: "ack", mode: "send" });
    f.epoch.abort();
    expect(
      f.files.serveFileOffer.mock.calls[0][1].signal
        .aborted,
    ).toBe(true);
  });

  it.each([
    [
      "not originally offered",
      (f: ReturnType<typeof setup>) => {
        f.offer.deliveries = {};
      },
      {},
    ],
    [
      "unsupported peer",
      (f: ReturnType<typeof setup>) => {
        f.offer.deliveries = { peer: "unsupported" };
      },
      {},
    ],
    [
      "deleted offer",
      (f: ReturnType<typeof setup>) => f.deleteOffer(),
      {},
    ],
    ["wrong room", () => {}, { roomId: "other" }],
    ["stale token", () => {}, { recipientToken: "old" }],
    ["wrong file", () => {}, { fid: "other" }],
    ["out of bounds", () => {}, { ranges: [2] }],
  ])(
    "rejects %s before starting binary transfer",
    async (_label, mutate, payload) => {
      const f = setup(true);
      mutate(f);
      await f.pull(payload);
      expect(f.files.serveFileOffer).not.toHaveBeenCalled();
      expect(
        f.transport.sendCalls.at(-1)?.message.type,
      ).toBe("error");
    },
  );

  it("refuses a stored offer from a different conversation before opening a receiver", async () => {
    const f = setup();
    f.offer.conversationId = "old-room";
    await expect(
      f.service.requestFile(f.offer),
    ).rejects.toThrow("original room");
    expect(f.files.receiveFileOffer).not.toHaveBeenCalled();
  });
});
