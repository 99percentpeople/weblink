// @vitest-environment jsdom
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RoomMessagingService,
  type RoomChatScope,
} from "@/libs/application/messaging/room-messaging-service";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import {
  createSessionMessage,
  ROOM_FILE_FEATURE,
  type RoomCapabilitiesMessage,
  type SendRoomFileMessage,
} from "@/libs/domain/protocol/messages";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "@/libs/domain/session";
import type {
  FileTransferMessage,
  RoomMessage,
} from "@/libs/domain/message";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "../support/rtc-transport";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});
const info = {
  id: "file",
  fileName: "report.pdf",
  fileSize: 8192,
  chunkSize: 4096,
  mimetype: "application/pdf",
};

function setup(
  peers: Record<string, string[] | undefined> = {
    peer: [ROOM_FILE_FEATURE],
  },
  acknowledge = true,
  supportsFiles = true,
) {
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  const state = {
    room: {
      roomId: "room",
      namespace: "server",
      conversationId: "room-conversation",
    } as RoomChatScope | null,
  };
  const sessions = new Map<string, PeerSession>();
  const emitters = new Map<
    string,
    MultiEventEmitter<PeerSessionEventMap>
  >();
  const offers = new Map<string, RoomCapabilitiesMessage>();
  const failed = new Set<string>();
  const messages = new Map<string, RoomMessage>();
  const store = {
    putRoomMessage: vi.fn(async (message: RoomMessage) => {
      if (messages.has(message.id)) return false;
      messages.set(message.id, structuredClone(message));
      return true;
    }),
    setRoomDelivery: vi.fn(
      async (
        id: string,
        peer: string,
        status:
          | "sending"
          | "delivered"
          | "failed"
          | "unsupported",
      ) => {
        messages.get(id)!.deliveries![peer] = status;
      },
    ),
  };
  const onFileReceived =
    vi.fn<(message: FileTransferMessage) => void>();
  const service = new RoomMessagingService(protocol, {
    supportsFiles,
    onFileReceived,
    getRoom: () => state.room,
    getSessions: () => [...sessions.values()],
    getLocalClient: () => ({
      clientId: "local",
      name: "Local",
      avatar: "large-local-only-avatar",
    }),
    store,
  });
  const addPeer = (id: string) => {
    const emitter =
      new MultiEventEmitter<PeerSessionEventMap>();
    const session = {
      clientId: "local",
      targetClientId: id,
      isMessageChannelReady: true,
      addEventListener:
        emitter.addEventListener.bind(emitter),
    } as unknown as PeerSession;
    sessions.set(id, session);
    emitters.set(id, emitter);
    return session;
  };
  Object.keys(peers).forEach(addPeer);
  transport.sendImpl = async (session, message) => {
    const remote = {
      clientId: session.targetClientId,
      targetClientId: "local",
    };
    if (message.type === "room-capabilities") {
      offers.set(session.targetClientId, message);
      await transport.emit(
        session,
        createSessionMessage(
          remote,
          "room-capabilities",
          {
            roomId: "room",
            token: `${session.targetClientId}-token`,
            features: peers[session.targetClientId],
          },
          {
            id: `cap-${message.id}`,
            createdAt: message.createdAt,
          },
        ),
      );
      if (acknowledge)
        await transport.emit(
          session,
          createSessionMessage(
            remote,
            "ack",
            { mode: "receive" },
            { id: message.id },
          ),
        );
    } else if (
      message.type === "send-room-file" ||
      message.type === "send-room-text"
    ) {
      if (failed.has(session.targetClientId))
        throw new Error("temporary send failure");
      await transport.emit(
        session,
        createSessionMessage(
          remote,
          "ack",
          { mode: "receive" },
          { id: message.id },
        ),
      );
    }
  };
  const incoming = (
    id = "incoming",
    peer = "peer",
  ): SendRoomFileMessage =>
    createSessionMessage(
      { clientId: peer, targetClientId: "local" },
      "send-room-file",
      {
        roomId: "room",
        senderToken: `${peer}-token`,
        recipientToken: offers.get(peer)!.token,
        senderName: peer,
        senderAvatar: null,
        fid: info.id,
        fileName: info.fileName,
        fileSize: info.fileSize,
        chunkSize: info.chunkSize,
      },
      { id },
    );
  const sync = async () => {
    service.syncSessions();
    await flushRtc();
    await flushRtc();
  };
  disposers.push(() => {
    service.dispose();
    protocol.dispose();
  });
  return {
    service,
    transport,
    state,
    sessions,
    emitters,
    offers,
    store,
    messages,
    onFileReceived,
    failed,
    addPeer,
    incoming,
    sync,
  };
}

describe("room file offers", () => {
  it("rejects a file prepared before leaving and rejoining the same room", async () => {
    const fixture = setup();
    await fixture.sync();
    const originalRoom = { ...fixture.state.room! };
    const originalScope = fixture.service.currentScopeKey!;
    fixture.state.room = null;
    await fixture.sync();
    fixture.state.room = originalRoom;
    await fixture.sync();
    expect(fixture.service.currentScopeKey).not.toBe(
      originalScope,
    );
    await expect(
      fixture.service.sendFile(
        info,
        originalScope,
        "stale-preparation",
      ),
    ).rejects.toThrow("Room changed");
    expect(fixture.messages.size).toBe(0);
    expect(
      fixture.transport.sendCalls.some(
        (call) => call.message.type === "send-room-file",
      ),
    ).toBe(false);
  });
  it.each(["rotated-token", "withdrawn-feature"])(
    "retires a captured file binding after %s",
    async (change) => {
      const fixture = setup();
      await fixture.sync();
      const session = fixture.sessions.get("peer")!;
      const binding =
        await fixture.service.getFileBinding(session);
      await fixture.transport.emit(
        session,
        createSessionMessage(
          { clientId: "peer", targetClientId: "local" },
          "room-capabilities",
          {
            roomId: "room",
            token:
              change === "rotated-token"
                ? "replacement-token"
                : "peer-token",
            features:
              change === "withdrawn-feature"
                ? []
                : [ROOM_FILE_FEATURE],
          },
          {
            createdAt:
              fixture.offers.get("peer")!.createdAt + 1,
          },
        ),
      );
      expect(binding.signal.aborted).toBe(true);
      expect(() => binding.assertCurrent()).toThrow();
      if (change === "withdrawn-feature")
        expect(fixture.service.fileCapabilities.peer).toBe(
          "unsupported",
        );
    },
  );
  it("keeps text compatible with room v1 peers and sends metadata only to file-capable peers", async () => {
    const fixture = setup({
      modern: [ROOM_FILE_FEATURE],
      old: undefined,
      future: ["another-feature"],
    });
    await fixture.sync();
    expect(fixture.service.capabilities).toEqual({
      modern: "supported",
      old: "supported",
      future: "supported",
    });
    expect(fixture.service.fileCapabilities).toEqual({
      modern: "supported",
      old: "unsupported",
      future: "unsupported",
    });
    expect(fixture.offers.get("modern")!.features).toEqual([
      ROOM_FILE_FEATURE,
    ]);
    await fixture.service.sendFile(
      info,
      fixture.service.currentScopeKey!,
      "outgoing",
    );
    expect(fixture.messages.get("outgoing")).toMatchObject({
      type: "file",
      deliveries: {
        modern: "delivered",
        old: "unsupported",
        future: "unsupported",
      },
    });
    const sent = fixture.transport.sendCalls.filter(
      (call) => call.message.type === "send-room-file",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatchObject({
      id: "outgoing",
      target: "modern",
      senderAvatar: null,
      fid: "file",
    });
    expect(
      fixture.transport.sendCalls.some(
        (call) =>
          call.message.type === "send-file" ||
          call.message.type === "request-file",
      ),
    ).toBe(false);
    expect(
      fixture.messages.get("outgoing"),
    ).not.toHaveProperty("transferStatus");
    await fixture.service.send("still text");
    expect(
      fixture.transport.sendCalls.filter(
        (call) => call.message.type === "send-room-text",
      ),
    ).toHaveLength(3);
  });

  it("does not advertise or accept file offers when local support is disabled", async () => {
    const fixture = setup(undefined, true, false);
    await fixture.sync();
    expect(
      fixture.offers.get("peer")!.features ?? [],
    ).not.toContain(ROOM_FILE_FEATURE);
    const message = fixture.incoming();
    await fixture.transport.emit(
      fixture.sessions.get("peer")!,
      message,
    );
    expect(fixture.messages.size).toBe(0);
    expect(
      fixture.transport.sendCalls.at(-1)!.message,
    ).toMatchObject({ type: "error", id: message.id });
  });

  it("accepts a token-validated incoming offer before the reciprocal capability ACK arrives", async () => {
    const fixture = setup(undefined, false);
    await fixture.sync();
    expect(fixture.service.capabilities.peer).toBe(
      "checking",
    );
    await fixture.transport.emit(
      fixture.sessions.get("peer")!,
      fixture.incoming(),
    );
    expect(fixture.messages.get("incoming")).toMatchObject({
      type: "file",
      fid: "file",
    });
    expect(
      fixture.transport.sendCalls.at(-1)!.message,
    ).toMatchObject({
      type: "ack",
      id: "incoming",
      mode: "receive",
    });
  });

  it("ACKs an incoming offer only after durable insertion and permits a retry after storage failure", async () => {
    const fixture = setup();
    await fixture.sync();
    const gate = deferred<boolean>();
    fixture.store.putRoomMessage.mockImplementationOnce(
      () => gate.promise,
    );
    const message = fixture.incoming();
    const receiving = fixture.transport.emit(
      fixture.sessions.get("peer")!,
      message,
    );
    await flushRtc();
    expect(
      fixture.transport.sendCalls.some(
        (call) =>
          call.message.type === "ack" &&
          call.message.id === "incoming",
      ),
    ).toBe(false);
    gate.reject(new Error("disk full"));
    await receiving;
    expect(fixture.messages.size).toBe(0);
    expect(fixture.onFileReceived).not.toHaveBeenCalled();
    await fixture.transport.emit(
      fixture.sessions.get("peer")!,
      message,
    );
    expect(fixture.messages.get("incoming")).toMatchObject({
      type: "file",
    });
    expect(
      fixture.transport.sendCalls.at(-1)!.message,
    ).toMatchObject({ type: "ack", id: "incoming" });
    expect(fixture.onFileReceived).toHaveBeenCalledOnce();
  });

  it("notifies file reception once after persistence, without replaying history or waiting for a download", async () => {
    const fixture = setup();
    await fixture.sync();
    const gate = deferred<void>();
    fixture.store.putRoomMessage.mockImplementationOnce(
      async (message) => {
        await gate.promise;
        fixture.messages.set(
          message.id,
          structuredClone(message),
        );
        return true;
      },
    );
    // A download can remain pending while the metadata receipt is acknowledged.
    const download = deferred<void>();
    fixture.onFileReceived.mockImplementation(
      () => download.promise,
    );
    const message = fixture.incoming();
    const session = fixture.sessions.get("peer")!;
    const receiving = fixture.transport.emit(
      session,
      message,
    );
    await flushRtc();
    expect(fixture.onFileReceived).not.toHaveBeenCalled();
    gate.resolve();
    await receiving;
    expect(fixture.onFileReceived).toHaveBeenCalledOnce();
    expect(fixture.onFileReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        id: message.id,
        conversationId: "room-conversation",
        status: "received",
      }),
    );
    expect(
      fixture.transport.sendCalls.at(-1)!.message,
    ).toMatchObject({ type: "ack", id: message.id });

    await fixture.transport.emit(session, message);
    const history = fixture.incoming("history");
    fixture.messages.set(history.id, {
      ...fixture.messages.get(message.id)!,
      id: history.id,
    });
    await fixture.transport.emit(session, history);
    expect(fixture.onFileReceived).toHaveBeenCalledOnce();
    download.resolve();
  });

  it("rejects stale binding tokens and a prepared file from an earlier room", async () => {
    const fixture = setup();
    await fixture.sync();
    await fixture.transport.emit(
      fixture.sessions.get("peer")!,
      {
        ...fixture.incoming(),
        recipientToken: "old-token",
      },
    );
    expect(fixture.messages.size).toBe(0);
    const scope = fixture.service.currentScopeKey!;
    fixture.state.room = {
      roomId: "other",
      namespace: "server",
      conversationId: "other-conversation",
    };
    await expect(
      fixture.service.sendFile(info, scope, "wrong-room"),
    ).rejects.toThrow("Room changed");
    expect(fixture.messages.size).toBe(0);
  });

  it("retries only failed original file recipients, leaving successful and later peers untouched", async () => {
    const peers = {
      a: [ROOM_FILE_FEATURE],
      b: [ROOM_FILE_FEATURE],
    } as Record<string, string[]>;
    const fixture = setup(peers);
    await fixture.sync();
    fixture.failed.add("b");
    await fixture.service.sendFile(
      info,
      fixture.service.currentScopeKey!,
      "outgoing",
    );
    expect(
      fixture.messages.get("outgoing")!.deliveries,
    ).toEqual({ a: "delivered", b: "failed" });
    fixture.failed.clear();
    peers.c = [ROOM_FILE_FEATURE];
    fixture.addPeer("c");
    await fixture.sync();
    const before = fixture.transport.sendCalls.length;
    await fixture.service.retry(
      fixture.messages.get("outgoing")!,
    );
    const sent = fixture.transport.sendCalls
      .slice(before)
      .filter(
        (call) => call.message.type === "send-room-file",
      );
    expect(sent.map((call) => call.message.target)).toEqual(
      ["b"],
    );
    expect(
      fixture.messages.get("outgoing")!.deliveries,
    ).toEqual({ a: "delivered", b: "delivered" });
  });
});
